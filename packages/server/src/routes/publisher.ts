import { Hono } from "hono";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { defineChain } from "viem";
import {
  proxyStore,
  callTracker,
  hiddenEndpoints,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_PAYMENT_TIMEOUT_SECONDS,
  DEFAULT_CONTENT_TYPE,
  MIN_MAX_CONCURRENT,
  MAX_MAX_CONCURRENT,
  MIN_PAYMENT_TIMEOUT_SECONDS,
  MAX_PAYMENT_TIMEOUT_SECONDS,
  type ContentType,
} from "../services/proxyStore";
import { getLivenessSummary, probeEndpointNow } from "../services/liveness";

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

  // 5. Validate + clamp the new capacity fields. We clamp silently instead of
  //    rejecting, so the frontend can be strict while older clients stay usable.
  const maxConcurrentRaw = Number(body.maxConcurrent);
  const maxConcurrent = Number.isFinite(maxConcurrentRaw)
    ? Math.min(MAX_MAX_CONCURRENT, Math.max(MIN_MAX_CONCURRENT, Math.floor(maxConcurrentRaw)))
    : DEFAULT_MAX_CONCURRENT;

  const paymentTimeoutRaw = Number(body.paymentTimeoutSeconds);
  const paymentTimeoutSeconds = Number.isFinite(paymentTimeoutRaw)
    ? Math.min(MAX_PAYMENT_TIMEOUT_SECONDS, Math.max(MIN_PAYMENT_TIMEOUT_SECONDS, Math.floor(paymentTimeoutRaw)))
    : DEFAULT_PAYMENT_TIMEOUT_SECONDS;

  const contentType: ContentType =
    body.contentType === "webpage" ? "webpage" :
    body.contentType === "api"     ? "api" :
    DEFAULT_CONTENT_TYPE;

  // 6. Store proxy config
  proxyStore.set({
    endpointId:     Number(endpointId),
    name:           (body.name || "").trim() || `Endpoint #${endpointId}`,
    backendUrl,
    injectHeaders:  injectHeaders || {},
    publisherAddr:  walletAddress.toLowerCase(),
    requireWorldId: body.requireWorldId === true,
    registeredAt:   new Date(),
    maxConcurrent,
    paymentTimeoutSeconds,
    contentType,
  });

  // Re-publishing an endpoint the publisher had previously hidden or
  // deleted should bring it back into view. Clear any hidden flag.
  hiddenEndpoints.unhide(Number(endpointId), walletAddress.toLowerCase());

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
  // Delete is more than "hide": the proxy_config row is gone, so any call
  // to /api/proxy/id returns 404. We ALSO mark the endpoint as hidden so
  // it disappears from the publisher's Manage list and the public Dashboard.
  // Re-publishing via POST /proxy-config un-hides it automatically.
  hiddenEndpoints.hide(id, walletAddress.toLowerCase());
  console.log(`[proxy-config] 🗑  Endpoint #${id} proxy deleted (and hidden) by ${walletAddress}`);
  return c.json({
    success: true,
    deleted: true,
    hidden: true,
    message: `Proxy for endpoint #${id} deleted. The on-chain registry entry still exists but /api/proxy/${id} now returns 404. Re-publish from the form to bring it back.`,
  });
});

/**
 * Shared verify helper for the hide/unhide routes. Returns the lowercased
 * wallet address on success, or a { error, status } object on failure.
 */
async function verifyOwnershipOfEndpoint(
  id: number,
  body: any,
  action: "hide" | "unhide"
): Promise<{ ok: true; address: string } | { ok: false; error: string; status: 400 | 403 | 500 }> {
  const { walletAddress, signature, timestamp } = body;
  if (!walletAddress || !signature || !timestamp) {
    return { ok: false, error: "Missing required fields: walletAddress, signature, timestamp", status: 400 };
  }
  if (Math.abs(Date.now() - Number(timestamp)) > 10 * 60 * 1000) {
    return { ok: false, error: "Signature timestamp expired (must be within 10 minutes)", status: 400 };
  }

  const message = `AgentGate ${action} endpoint\nendpointId: ${id}\ntimestamp: ${timestamp}`;
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (err: any) {
    return { ok: false, error: `Invalid signature: ${err.message}`, status: 400 };
  }
  if (recovered.toLowerCase() !== String(walletAddress).toLowerCase()) {
    return { ok: false, error: "Signature mismatch", status: 403 };
  }

  try {
    const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
    const ep = await client.readContract({
      address: REGISTRY, abi: REGISTRY_ABI,
      functionName: "endpoints", args: [BigInt(id)],
    }) as readonly [bigint, `0x${string}`, ...unknown[]];
    if (ep[1].toLowerCase() !== String(walletAddress).toLowerCase()) {
      return { ok: false, error: `Unauthorized: not the endpoint owner`, status: 403 };
    }
  } catch (err: any) {
    return { ok: false, error: `Could not verify ownership: ${err.message}`, status: 500 };
  }

  return { ok: true, address: String(walletAddress).toLowerCase() };
}

/**
 * POST /api/publisher/proxy-config/:endpointId/hide
 *
 * Hides an endpoint from the publisher's own Manage list and from the public
 * Dashboard. The endpoint stays on-chain and the proxy keeps serving paid
 * calls for buyers who already have the URL — this is a listing filter, not
 * a kill switch. Signature message:
 *   `AgentGate hide endpoint\nendpointId: <id>\ntimestamp: <ts>`
 */
router.post("/proxy-config/:endpointId/hide", async (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const check = await verifyOwnershipOfEndpoint(id, body, "hide");
  if (!check.ok) return c.json({ error: check.error }, check.status);

  hiddenEndpoints.hide(id, check.address);
  console.log(`[proxy-config] 🙈  Endpoint #${id} hidden by ${check.address}`);
  return c.json({ success: true, hidden: true, endpointId: id });
});

/**
 * POST /api/publisher/proxy-config/:endpointId/unhide
 *
 * Inverse of /hide. Brings the endpoint back into the Manage list and the
 * public Dashboard. Same signature pattern.
 */
router.post("/proxy-config/:endpointId/unhide", async (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const check = await verifyOwnershipOfEndpoint(id, body, "unhide");
  if (!check.ok) return c.json({ error: check.error }, check.status);

  hiddenEndpoints.unhide(id, check.address);
  console.log(`[proxy-config] 👀  Endpoint #${id} un-hidden by ${check.address}`);
  return c.json({ success: true, hidden: false, endpointId: id });
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
    maxConcurrent:  config.maxConcurrent,
    paymentTimeoutSeconds: config.paymentTimeoutSeconds,
    contentType:    config.contentType,
    proxyUrl:       `/api/proxy/${config.endpointId}`,
  });
});

/**
 * GET /api/publisher/liveness/:endpointId
 * Returns the latest liveness probe results for an endpoint (up/down,
 * uptime %, recent check history). The server runs probes on a timer
 * so this is just reading from an in-memory ring buffer — cheap.
 */
router.get("/liveness/:endpointId", (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);
  return c.json(getLivenessSummary(id));
});

/**
 * POST /api/publisher/liveness/:endpointId/check-now
 * Forces an immediate probe of this endpoint. Useful for a "Check now"
 * button in the dashboard so publishers don't wait for the next tick.
 * Intentionally open (no signature required) — it only does a HEAD fetch
 * against the backend URL already on file, no state mutation beyond
 * appending to the ring buffer.
 */
router.post("/liveness/:endpointId/check-now", async (c) => {
  const id = parseInt(c.req.param("endpointId"));
  if (isNaN(id)) return c.json({ error: "Invalid endpointId" }, 400);
  const summary = await probeEndpointNow(id);
  return c.json(summary);
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
