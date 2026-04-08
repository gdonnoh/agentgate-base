/**
 * proxy.ts
 *
 * Handles GET/POST /api/proxy/:endpointId
 *
 * Flow:
 *   1. No PAYMENT-SIGNATURE  → return 402 with Base Sepolia USDC payment terms
 *   2. PAYMENT-SIGNATURE present → verify via x402.org facilitator
 *   3. Valid payment → forward request to backend URL with injected auth headers
 *   4. Return upstream response verbatim
 */

import { Hono } from "hono";
import { createPublicClient, http } from "viem";
import { defineChain } from "viem";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { proxyStore, callTracker } from "../services/proxyStore";
import { validateAgentKitHeader } from "../services/agentkit";
import { config, USDC_ADDRESS } from "../config";
import { paywallHtml } from "../paywall";

const BASE_SEPOLIA_RPC = process.env.RPC_URL || "https://sepolia.base.org";
const REGISTRY    = (process.env.PUBLISHER_REGISTRY || "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2") as `0x${string}`;
const PLATFORM_WALLET = config.platformAddress as `0x${string}`;
const PLATFORM_FEE_PCT = config.platformFeePct;

// Replay protection for browser direct-transfer payments
const usedBrowserTxHashes = new Set<string>();

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

const facilitator = new HTTPFacilitatorClient({ url: "https://www.x402.org/facilitator" });


const router = new Hono();

/** Forward the request to the upstream backend (shared by free-trial + paid paths) */
async function forwardToUpstream(c: any, proxyConfig: any, endpointId: number): Promise<Response> {
  const method     = c.req.method;
  const bodyBuffer = method !== "GET" && method !== "HEAD" ? await c.req.arrayBuffer() : undefined;

  const upstreamHeaders: Record<string, string> = {};
  const ct = c.req.header("content-type");
  if (ct) upstreamHeaders["content-type"] = ct;
  const accept = c.req.header("accept");
  if (accept) upstreamHeaders["accept"] = accept;

  for (const [k, v] of Object.entries(proxyConfig.injectHeaders as Record<string, string>)) {
    upstreamHeaders[k.toLowerCase()] = v;
  }

  const rawPath  = c.req.path;
  const suffix   = rawPath.replace(new RegExp(`^/api/proxy/${endpointId}`), "");
  const upstream = proxyConfig.backendUrl.replace(/\/$/, "") + suffix;
  const qs       = c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "";

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream + qs, { method, headers: upstreamHeaders, body: bodyBuffer });
  } catch (err: any) {
    console.error(`[proxy] Upstream fetch failed:`, err.message);
    return c.json({ error: `Upstream error: ${err.message}` }, 502);
  }

  console.log(`[proxy] ← upstream ${upstreamRes.status} for endpoint #${endpointId} → ${upstream}`);
  const upstreamBody = await upstreamRes.arrayBuffer();
  const upCt = upstreamRes.headers.get("content-type") || "application/json";
  return new Response(upstreamBody, { status: upstreamRes.status, headers: { "content-type": upCt } });
}

/**
 * Convert USD price to USDC amount string (6 decimals).
 * e.g. $0.01 → "10000"
 */
function usdToUsdcUnits(usdAmount: number): string {
  return Math.ceil(usdAmount * 1_000_000).toString();
}

// ── GET or POST /api/proxy/:endpointId[/*] ─────────────────────────────────
router.all("/:endpointId/*", async (c) => {
  const endpointId = parseInt(c.req.param("endpointId"), 10);
  if (isNaN(endpointId)) {
    return c.json({ error: "Invalid endpoint ID" }, 400);
  }

  // 1. Proxy config must exist
  const proxyConfig = proxyStore.get(endpointId);
  if (!proxyConfig) {
    return c.json({ error: `No proxy config for endpoint #${endpointId}. Register via POST /api/publisher/proxy-config` }, 404);
  }

  // 2. Read endpoint from chain to get price + publisher address
  let priceUsd = 0.01; // fallback (registry stores USD, 6 decimals)
  let publisherAddress = PLATFORM_WALLET;
  let onChainRequireWorldId = false;
  try {
    const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
    const ep = await client.readContract({
      address: REGISTRY, abi: REGISTRY_ABI,
      functionName: "endpoints", args: [BigInt(endpointId)],
    }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint, boolean];

    if (!ep[5]) return c.json({ error: "Endpoint is inactive" }, 403);
    priceUsd = Number(ep[3]) / 1_000_000;
    publisherAddress = ep[1];
    onChainRequireWorldId = ep[9]; // requireWorldId from contract
  } catch (err: any) {
    console.warn(`[proxy] Could not read endpoint #${endpointId} from chain:`, err.message);
  }

  // Use on-chain requireWorldId (falls back to proxyStore config)
  const requireWorldId = onChainRequireWorldId || proxyConfig.requireWorldId;

  // 3. WorldID verification + free-trial (only for endpoints that require WorldID)
  const agentkitHeader = c.req.header("agentkit") ?? c.req.header("AGENTKIT");
  let worldIdVerified = false;
  let worldIdAddress: string | undefined;

  if (agentkitHeader) {
    const akResult = await validateAgentKitHeader(agentkitHeader, c.req.url);
    if (akResult.valid && akResult.humanId) {
      worldIdVerified = true;
      worldIdAddress = akResult.address;
      console.log(`[proxy] ✅ WorldID verified: ${akResult.address} (humanId: ${akResult.humanId.slice(0, 10)}…)`);

      // Free-trial ONLY for WorldID-required endpoints (prevents sybil farming on open endpoints)
      if (requireWorldId) {
        const trial = callTracker.checkFreeTrial(akResult.address!, endpointId);
        if (trial.allowed) {
          callTracker.consumeFreeTrial(akResult.address!, endpointId);
          callTracker.record(endpointId, akResult.address!, true, 0, PLATFORM_FEE_PCT);
          console.log(`[proxy] 🎟  Free-trial call ${trial.used + 1}/3 for ${akResult.address} on endpoint #${endpointId}`);
          return await forwardToUpstream(c, proxyConfig, endpointId);
        }
        console.log(`[proxy] Free-trial exhausted for ${akResult.address} on endpoint #${endpointId} — payment required`);
      }
    } else if (akResult.valid && !akResult.humanId) {
      console.log(`[proxy] AgentKit valid but not in AgentBook: ${akResult.address} — not WorldID verified`);
    } else {
      if (requireWorldId) {
        return c.json({ error: `WorldID verification failed: ${akResult.error}`, requireWorldId: true }, 403);
      }
    }
  }

  // If WorldID is required but no valid proof provided, reject before payment
  if (requireWorldId && !worldIdVerified) {
    const amount = usdToUsdcUnits(priceUsd);
    const paymentRequired: any = {
      x402Version: 2,
      accepts: [{
        scheme: "exact", network: "eip155:84532", payTo: PLATFORM_WALLET,
        maxAmountRequired: amount, asset: USDC_ADDRESS,
        extra: { name: "USDC", version: "2", decimals: 6, assetTransferMethod: "permit2" },
        resource: c.req.url, description: proxyConfig.name, maxTimeoutSeconds: 60,
      }],
      requireWorldId: true,
      worldIdInfo: "This endpoint requires WorldID. Include a valid `agentkit` header. Verified agents get 3 free calls.",
    };
    c.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(paymentRequired)).toString("base64"));
    return c.json(paymentRequired, 402);
  }

  // 3b. Browser direct-transfer payment verification (simpler than x402 for paywall page)
  const browserTxHash = c.req.header("x-payment-tx");
  const browserFrom = c.req.header("x-payment-from");
  if (browserTxHash && browserFrom) {
    try {
      const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
      const receipt = await client.getTransactionReceipt({ hash: browserTxHash as `0x${string}` });

      if (receipt.status !== "success") {
        return c.json({ error: "Payment transaction failed on-chain" }, 402);
      }

      // Parse USDC Transfer event: Transfer(from, to, amount)
      const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const requiredAmount = BigInt(usdToUsdcUnits(priceUsd));
      const found = receipt.logs.find((log: any) => {
        if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) return false;
        if (log.topics[0] !== TRANSFER_TOPIC) return false;
        const from = "0x" + log.topics[1].slice(26).toLowerCase();
        const to = "0x" + log.topics[2].slice(26).toLowerCase();
        const amount = BigInt(log.data);
        return from === browserFrom.toLowerCase() && to === PLATFORM_WALLET.toLowerCase() && amount >= requiredAmount;
      });

      if (!found) {
        return c.json({ error: "Payment tx does not contain matching USDC transfer" }, 402);
      }

      // Replay protection: check we haven't processed this tx before
      if (usedBrowserTxHashes.has(browserTxHash)) {
        return c.json({ error: "Payment tx already used" }, 402);
      }
      usedBrowserTxHashes.add(browserTxHash);

      const platformFee = priceUsd * (PLATFORM_FEE_PCT / 100);
      const publisherNet = priceUsd - platformFee;
      console.log(`[proxy] ✅ Browser payment verified for #${endpointId}: $${priceUsd} via tx ${browserTxHash.slice(0, 12)}… ($${publisherNet.toFixed(4)} publisher + $${platformFee.toFixed(4)} platform)`);
      callTracker.record(endpointId, browserFrom, false, priceUsd, PLATFORM_FEE_PCT);

      // Browser path: redirect directly to the original backend URL
      // (so CSS/JS/images load from the original origin, not the proxy)
      return c.json({ redirect: proxyConfig.backendUrl });
    } catch (err: any) {
      console.warn(`[proxy] Browser tx verification failed:`, err.message);
      return c.json({ error: `Payment verification failed: ${err.message}` }, 500);
    }
  }

  // 4. Check for payment
  const paymentHeader = c.req.header("PAYMENT-SIGNATURE") || c.req.header("payment-signature");

  if (!paymentHeader) {
    const amount  = usdToUsdcUnits(priceUsd);
    const accepts = [{
      scheme:  "exact",
      network: "eip155:84532",
      payTo: PLATFORM_WALLET,
      maxAmountRequired: amount,
      amount,
      asset:   USDC_ADDRESS,
      extra: { name: "USDC", version: "2", decimals: 6, assetTransferMethod: "permit2" },
      resource: c.req.url,
      description: proxyConfig.name,
      maxTimeoutSeconds: 60,
    }];
    const paymentRequired: any = { x402Version: 2, accepts };
    if (requireWorldId) {
      paymentRequired.requireWorldId = true;
      paymentRequired.freeTrialInfo = "WorldID-verified agents get 3 free calls. Include `agentkit` header for free-trial.";
    }
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
    c.header("PAYMENT-REQUIRED", encoded);

    // Browser detection: if the request wants HTML, serve an interactive paywall page
    const accept = c.req.header("accept") || "";
    const isBrowser = c.req.method === "GET" && accept.includes("text/html");
    if (isBrowser) {
      // Build absolute URL forcing https behind proxies (Render/Cloudflare)
      const forwardedProto = c.req.header("x-forwarded-proto");
      const host = c.req.header("host") || "localhost:4021";
      const proto = forwardedProto || (host.includes("localhost") ? "http" : "https");
      const absUrl = `${proto}://${host}${c.req.path}`;

      const html = paywallHtml({
        endpointId,
        endpointName: proxyConfig.name || `Endpoint #${endpointId}`,
        priceUsd,
        usdcAmount: amount,
        payTo: PLATFORM_WALLET,
        backendUrl: proxyConfig.backendUrl,
        requireWorldId,
        proxyUrl: absUrl,
      });
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(html, 402);
    }

    c.header("Content-Type", "application/json");
    return c.json(paymentRequired, 402);
  }

  // 5. Pre-flight: verify the backend is alive BEFORE accepting payment
  //    This protects agents from paying for broken/fake endpoints.
  try {
    const healthCheck = await fetch(proxyConfig.backendUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (healthCheck.status >= 500) {
      console.warn(`[proxy] Backend down for endpoint #${endpointId}: ${healthCheck.status}`);
      return c.json({
        error: `Backend is currently unavailable (HTTP ${healthCheck.status}). Payment was NOT processed — you were not charged.`,
        backendStatus: healthCheck.status,
      }, 503);
    }
  } catch (err: any) {
    console.warn(`[proxy] Backend unreachable for endpoint #${endpointId}: ${err.message}`);
    return c.json({
      error: `Backend is unreachable. Payment was NOT processed — you were not charged.`,
    }, 503);
  }

  // 6. Verify payment via x402.org facilitator (only after backend pre-flight passes)
  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    return c.json({ error: "Invalid PAYMENT-SIGNATURE header (not base64 JSON)" }, 400);
  }

  const amount         = usdToUsdcUnits(priceUsd);
  const requirements   = { scheme: "exact", network: "eip155:84532", payTo: PLATFORM_WALLET, maxAmountRequired: amount, amount, asset: USDC_ADDRESS, extra: { name: "USDC", version: "2", decimals: 6, assetTransferMethod: "permit2" }, maxTimeoutSeconds: 60, resource: c.req.url };
  const verifyResult   = await facilitator.verify(paymentPayload, requirements as any);

  if (!verifyResult.isValid) {
    console.warn(`[proxy] Payment invalid for endpoint #${endpointId}: ${verifyResult.invalidReason}`);
    return c.json({ error: `Payment invalid: ${verifyResult.invalidReason}` }, 402);
  }

  const platformFee = priceUsd * (PLATFORM_FEE_PCT / 100);
  const publisherNet = priceUsd - platformFee;
  console.log(`[proxy] ✅ Payment verified for endpoint #${endpointId}: $${priceUsd} total → $${publisherNet.toFixed(4)} publisher + $${platformFee.toFixed(4)} platform fee (${PLATFORM_FEE_PCT}%)`);
  callTracker.record(endpointId, worldIdAddress || "unknown", false, priceUsd, PLATFORM_FEE_PCT);

  // 7. Forward the actual request to upstream backend
  return await forwardToUpstream(c, proxyConfig, endpointId);
});

export default router;
