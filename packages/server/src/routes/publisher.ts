import { Hono } from "hono";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { defineChain } from "viem";
import { proxyStore, callTracker } from "../services/proxyStore";

const BASE_SEPOLIA_RPC = process.env.RPC_URL || "https://sepolia.base.org";
const REGISTRY    = (process.env.PUBLISHER_REGISTRY || "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2") as `0x${string}`;

const baseSepoliaChain = defineChain({
  id: 84532, name: "Base Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_SEPOLIA_RPC] } },
});

const REGISTRY_ABI = [
  {
    name: "endpoints",
    type: "function",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "id",           type: "uint256" },
      { name: "publisher",    type: "address" },
      { name: "url",          type: "string"  },
      { name: "pricePerCall", type: "uint256" },
      { name: "paymaster",    type: "address" },
      { name: "active",       type: "bool"    },
      { name: "totalCalls",   type: "uint256" },
      { name: "totalRevenue", type: "uint256" },
      { name: "registeredAt", type: "uint256" },
      { name: "requireWorldId", type: "bool" },
    ],
    stateMutability: "view",
  },
] as const;

const router = new Hono();

// In-memory store for demo purposes
const publisherStats: Record<
  string,
  { gasSpent: number; revenue: number; calls: number; endpoints: string[] }
> = {};

router.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url || !body?.pricePerCall || !body?.publisherAddress) {
    return c.json({ error: "Missing required fields: url, pricePerCall, publisherAddress" }, 400);
  }

  const { url, pricePerCall, publisherAddress, paymasterAddress } = body;

  if (!publisherStats[publisherAddress]) {
    publisherStats[publisherAddress] = { gasSpent: 0, revenue: 0, calls: 0, endpoints: [] };
  }
  publisherStats[publisherAddress].endpoints.push(url);

  return c.json({
    success: true,
    endpointId: Math.floor(Math.random() * 10000),
    url,
    pricePerCall,
    publisherAddress,
    paymasterAddress: paymasterAddress || null,
    message: "Endpoint registered (demo mode — no on-chain tx)",
  });
});

router.get("/stats/:address", (c) => {
  const address = c.req.param("address").toLowerCase();
  const stats = publisherStats[address] || {
    gasSpent: 0.003,
    revenue: 0.015,
    calls: 3,
    endpoints: ["https://agentgate.demo/api/weather", "https://agentgate.demo/api/prices"],
  };

  return c.json({
    address,
    gasSpentEth: stats.gasSpent,
    revenueUsdc: stats.revenue,
    totalCalls: stats.calls,
    roi: stats.gasSpent > 0 ? ((stats.revenue - stats.gasSpent) / stats.gasSpent) * 100 : 0,
    endpoints: stats.endpoints,
  });
});

router.get("/endpoints/:address", (c) => {
  const address = c.req.param("address").toLowerCase();
  const stats = publisherStats[address];

  return c.json({
    address,
    endpoints: stats?.endpoints ?? [
      "https://agentgate.demo/api/weather",
      "https://agentgate.demo/api/prices",
    ],
  });
});

/**
 * POST /api/publisher/proxy-config
 *
 * Registers a backend proxy for an on-chain endpoint.
 * The caller must prove ownership by signing a message with the same wallet
 * that published the endpoint (verified against PublisherRegistry on Base Sepolia).
 *
 * Body:
 *   endpointId:     number
 *   backendUrl:     string  — upstream URL (e.g. https://api.anthropic.com/v1/messages)
 *   injectHeaders:  Record<string, string>  — headers to inject (API keys etc.)
 *   walletAddress:  string  — your publisher wallet
 *   signature:      string  — EIP-191 signature of the message below
 *
 * Message signed: `AgentGate proxy config\nendpointId: <id>\nbackendUrl: <url>\ntimestamp: <ts>`
 */
router.post("/proxy-config", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { endpointId, backendUrl, injectHeaders, walletAddress, signature, timestamp } = body;

  if (endpointId === undefined || !backendUrl || !walletAddress || !signature || !timestamp) {
    return c.json({ error: "Missing required fields: endpointId, backendUrl, walletAddress, signature, timestamp" }, 400);
  }

  // 1. Check timestamp freshness (within 10 minutes)
  if (Math.abs(Date.now() - Number(timestamp)) > 10 * 60 * 1000) {
    return c.json({ error: "Signature timestamp expired (must be within 10 minutes)" }, 400);
  }

  // 2. Recover signer from EIP-191 signature
  const message = `AgentGate proxy config\nendpointId: ${endpointId}\nbackendUrl: ${backendUrl}\ntimestamp: ${timestamp}`;
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (err: any) {
    return c.json({ error: `Invalid signature: ${err.message}` }, 400);
  }

  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    return c.json({ error: "Signature mismatch: recovered address does not match walletAddress" }, 403);
  }

  // 3. Read endpoint from chain — verify walletAddress is the publisher
  try {
    const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
    const ep = await client.readContract({
      address: REGISTRY, abi: REGISTRY_ABI,
      functionName: "endpoints", args: [BigInt(endpointId)],
    }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint, boolean];

    const onChainPublisher = ep[1].toLowerCase();
    if (onChainPublisher !== walletAddress.toLowerCase()) {
      return c.json({ error: `Unauthorized: endpoint #${endpointId} is owned by ${ep[1]}, not ${walletAddress}` }, 403);
    }
  } catch (err: any) {
    return c.json({ error: `Could not verify endpoint ownership on-chain: ${err.message}` }, 500);
  }

  // 4. Verify backend is reachable before accepting the config
  let backendVerified = false;
  let backendStatus = 0;
  try {
    const testHeaders: Record<string, string> = {};
    // Inject auth headers for the test (some APIs need auth even for HEAD)
    for (const [k, v] of Object.entries(injectHeaders || {})) {
      testHeaders[k.toLowerCase()] = String(v);
    }
    const testRes = await fetch(backendUrl, {
      method: "HEAD",
      headers: testHeaders,
      signal: AbortSignal.timeout(8000),
    });
    backendStatus = testRes.status;
    // Accept 200, 402 (x402 endpoint), 405 (HEAD not allowed but server is up), 401/403 (auth works differently)
    backendVerified = testRes.status < 500;
  } catch (err: any) {
    console.warn(`[proxy-config] Backend test failed for ${backendUrl}: ${err.message}`);
  }

  if (!backendVerified) {
    return c.json({
      error: `Backend verification failed — ${backendUrl} returned ${backendStatus || "unreachable"}. Fix your backend URL or API key and try again.`,
      backendStatus,
    }, 422);
  }

  // 5. Store proxy config
  proxyStore.set({
    endpointId:     Number(endpointId),
    name:           (body.name || "").trim() || `Endpoint #${endpointId}`,
    backendUrl,
    injectHeaders:  injectHeaders || {},
    publisherAddr:  walletAddress.toLowerCase(),
    requireWorldId: body.requireWorldId === true,
    registeredAt:   new Date(),
  });

  console.log(`[proxy-config] ✅ Endpoint #${endpointId} → ${backendUrl} (verified, by ${walletAddress})`);

  return c.json({
    success:  true,
    proxyUrl: `/api/proxy/${endpointId}`,
    verified: true,
    message:  `Proxy configured and verified. Agents can now call /api/proxy/${endpointId} and pay USDC to reach ${backendUrl}`,
  });
});

/**
 * DELETE /api/publisher/proxy-config/:endpointId
 * Deactivates a proxy. Same EIP-191 ownership check as POST.
 * Body: { walletAddress, signature, timestamp }
 * Message signed: `AgentGate deactivate proxy\nendpointId: <id>\ntimestamp: <ts>`
 */
router.delete("/proxy-config/:endpointId", async (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const { walletAddress, signature, timestamp } = body;
  if (!walletAddress || !signature || !timestamp) {
    return c.json({ error: "Missing required fields: walletAddress, signature, timestamp" }, 400);
  }

  if (Math.abs(Date.now() - Number(timestamp)) > 10 * 60 * 1000) {
    return c.json({ error: "Signature timestamp expired (must be within 10 minutes)" }, 400);
  }

  const message = `AgentGate deactivate proxy\nendpointId: ${id}\ntimestamp: ${timestamp}`;
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (err: any) {
    return c.json({ error: `Invalid signature: ${err.message}` }, 400);
  }

  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    return c.json({ error: "Signature mismatch" }, 403);
  }

  // Verify on-chain ownership
  try {
    const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
    const ep = await client.readContract({
      address: REGISTRY, abi: REGISTRY_ABI,
      functionName: "endpoints", args: [BigInt(id)],
    }) as readonly [bigint, `0x${string}`, ...unknown[]];
    if (ep[1].toLowerCase() !== walletAddress.toLowerCase()) {
      return c.json({ error: `Unauthorized: not the endpoint owner` }, 403);
    }
  } catch (err: any) {
    return c.json({ error: `Could not verify ownership: ${err.message}` }, 500);
  }

  proxyStore.delete(id);
  console.log(`[proxy-config] 🗑  Endpoint #${id} proxy deactivated by ${walletAddress}`);
  return c.json({ success: true, message: `Proxy for endpoint #${id} deactivated.` });
});

/**
 * GET /api/publisher/proxy-config/:endpointId
 * Returns proxy info (without secret headers) for a given endpoint.
 */
router.get("/proxy-config/:endpointId", (c) => {
  const id     = parseInt(c.req.param("endpointId"));
  const config = proxyStore.get(id);
  if (!config) return c.json({ error: "No proxy config found" }, 404);

  return c.json({
    endpointId:     config.endpointId,
    name:           config.name,
    backendUrl:     config.backendUrl,
    headerCount:    Object.keys(config.injectHeaders).length,
    headerKeys:     Object.keys(config.injectHeaders),   // keys shown, values hidden
    publisherAddr:  config.publisherAddr,
    requireWorldId: config.requireWorldId,
    registeredAt:   config.registeredAt,
    proxyUrl:       `/api/proxy/${config.endpointId}`,
  });
});

/**
 * GET /api/publisher/proxy-stats/:endpointId
 * Returns call stats for an endpoint (total, free-trial, paid, unique agents).
 */
router.get("/proxy-stats/:endpointId", (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);
  const config = proxyStore.get(id);
  return c.json({
    endpointId: id,
    requireWorldId: config?.requireWorldId ?? false,
    ...callTracker.getStats(id),
  });
});

/**
 * GET /api/publisher/proxy-stats/:endpointId/agent/:address
 * Returns per-agent stats including free-trial remaining.
 */
router.get("/proxy-stats/:endpointId/agent/:address", (c) => {
  const id = parseInt(c.req.param("endpointId"));
  const address = c.req.param("address");
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);
  const config = proxyStore.get(id);
  return c.json({
    endpointId: id,
    agentAddress: address,
    requireWorldId: config?.requireWorldId ?? false,
    ...callTracker.getAgentStats(id, address),
  });
});

/**
 * GET /api/publisher/proxy-stats
 * Returns stats for all endpoints.
 */
router.get("/proxy-stats", (c) => {
  return c.json(callTracker.getAllStats());
});

/**
 * GET /api/platform/stats
 * Returns platform-wide revenue stats.
 */
router.get("/platform-stats", (c) => {
  const allStats = callTracker.getAllStats();
  let totalCalls = 0;
  let totalRevenue = 0;
  let platformRevenue = 0;
  let publisherRevenue = 0;
  let freeTrialCalls = 0;

  for (const stats of Object.values(allStats)) {
    totalCalls += stats.totalCalls;
    totalRevenue += stats.totalRevenue;
    platformRevenue += stats.platformRevenue;
    publisherRevenue += stats.publisherRevenue;
    freeTrialCalls += stats.freeTrialCalls;
  }

  return c.json({
    totalCalls,
    freeTrialCalls,
    paidCalls: totalCalls - freeTrialCalls,
    totalRevenue: totalRevenue.toFixed(4),
    platformRevenue: platformRevenue.toFixed(4),
    publisherRevenue: publisherRevenue.toFixed(4),
    platformFeePct: 5,
    endpoints: Object.keys(allStats).length,
  });
});

export default router;
