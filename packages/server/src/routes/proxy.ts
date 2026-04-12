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
import {
  proxyStore,
  callTracker,
  DEFAULT_PAYMENT_TIMEOUT_SECONDS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PRICE_PER_MILLION_TOKENS,
} from "../services/proxyStore";
import { validateAgentKitHeader } from "../services/agentkit";
import { config, USDC_ADDRESS } from "../config";
import { paywallHtml } from "../paywall";

// ── Per-endpoint concurrency tracker ─────────────────────────────────────────
// In-memory semaphore counting in-flight paid forwards per endpointId. When
// the count reaches proxyConfig.maxConcurrent we reject new requests with 429
// BEFORE accepting payment, so callers are never charged for capacity limits.
// This Map is intentionally local to this module — it's a soft guard, not a
// distributed lock. A restart resets counts, which is safe (callers retry).
const inFlightByEndpoint = new Map<number, number>();

function acquireSlot(endpointId: number, cap: number): boolean {
  const cur = inFlightByEndpoint.get(endpointId) ?? 0;
  if (cur >= cap) return false;
  inFlightByEndpoint.set(endpointId, cur + 1);
  return true;
}

function releaseSlot(endpointId: number): void {
  const cur = inFlightByEndpoint.get(endpointId) ?? 0;
  if (cur <= 1) inFlightByEndpoint.delete(endpointId);
  else inFlightByEndpoint.set(endpointId, cur - 1);
}

/** Read-only accessor used by the data routes so the dashboard can render a
 *  "busy" / "ready" / "saturated" badge next to each endpoint. */
export function getInFlightCount(endpointId: number): number {
  return inFlightByEndpoint.get(endpointId) ?? 0;
}

// ── Endpoint chain-read cache ────────────────────────────────────────────────
// The proxy used to do a fresh viem readContract on Base Sepolia for every
// incoming request, which added 500-1500ms of round-trip latency to every
// paid call. Since endpoint price/active/publisher change rarely, we cache
// the result in-memory with a short TTL. Trade-off: after a price change the
// old price is served for up to TTL seconds — acceptable given the upside.
interface EndpointCacheEntry {
  priceUsd: number;
  publisherAddress: `0x${string}`;
  requireWorldId: boolean;
  active: boolean;
  cachedAt: number;
}
const endpointChainCache = new Map<number, EndpointCacheEntry>();
const ENDPOINT_CACHE_TTL_MS = 15_000;

function getCachedEndpoint(id: number): EndpointCacheEntry | null {
  const entry = endpointChainCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ENDPOINT_CACHE_TTL_MS) {
    endpointChainCache.delete(id);
    return null;
  }
  return entry;
}

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

/** Forward the request to the upstream backend (shared by free-trial + paid paths).
 *
 * @param bodyOverride - Optional pre-read/mutated body buffer. When the
 *   caller has already consumed `c.req.arrayBuffer()` (e.g. to inject
 *   num_predict for per-token endpoints) it passes the resulting buffer
 *   here so we don't try to read the request stream a second time.
 */
async function forwardToUpstream(
  c: any,
  proxyConfig: any,
  endpointId: number,
  bodyOverride?: ArrayBuffer | Uint8Array,
): Promise<Response> {
  const method     = c.req.method;
  const bodyBuffer = bodyOverride !== undefined
    ? bodyOverride
    : (method !== "GET" && method !== "HEAD" ? await c.req.arrayBuffer() : undefined);

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

/**
 * Estimate the number of input tokens from a chat/generate request body.
 *
 * For the common LLM API shapes (Ollama /api/chat, OpenAI chat completions,
 * Anthropic messages) the token-bearing content lives inside a `messages[]`
 * array or a `prompt` string. We sum just those content strings and divide
 * by 4 — the rough rule of thumb for English. This is NOT exact (ideograms,
 * emoji, and code all vary) but it is a defensible budget estimate for
 * pricing — the publisher also sets a hard `maxInputTokens` cap, so the
 * worst-case exposure is bounded.
 *
 * When the body can't be parsed as JSON or has an unknown shape, we fall
 * back to `rawLen / 4` which over-counts tokens slightly. That is fine for
 * billing because it makes the buyer pay MORE than they strictly owe — the
 * proxy can't accidentally under-charge.
 */
function estimateInputTokens(parsedBody: any, rawText: string): number {
  const CHARS_PER_TOKEN = 4;
  try {
    if (parsedBody && Array.isArray(parsedBody.messages)) {
      // Chat-shaped body (Ollama + OpenAI + Anthropic all use this)
      let chars = 0;
      for (const m of parsedBody.messages) {
        if (typeof m?.content === "string") chars += m.content.length;
        // Anthropic uses content as an array of parts
        else if (Array.isArray(m?.content)) {
          for (const part of m.content) {
            if (typeof part?.text === "string") chars += part.text.length;
          }
        }
      }
      if (typeof parsedBody.system === "string") chars += parsedBody.system.length;
      return Math.ceil(chars / CHARS_PER_TOKEN);
    }
    if (parsedBody && typeof parsedBody.prompt === "string") {
      // Generate-shaped body (Ollama /api/generate, OpenAI completions)
      return Math.ceil(parsedBody.prompt.length / CHARS_PER_TOKEN);
    }
  } catch {
    /* fall through */
  }
  return Math.ceil(rawText.length / CHARS_PER_TOKEN);
}

/**
 * Pull actual token usage from a non-streaming upstream response body.
 * Supports the three major shapes:
 *   - Ollama   : { prompt_eval_count, eval_count }
 *   - OpenAI   : { usage: { prompt_tokens, completion_tokens } }
 *   - Anthropic: { usage: { input_tokens, output_tokens } }
 *
 * Returns null if no usage is present or the body isn't JSON.
 */
function parseUsageFromResponse(bodyText: string): { input: number; output: number } | null {
  try {
    const d = JSON.parse(bodyText);
    const input  = d?.prompt_eval_count ?? d?.usage?.prompt_tokens ?? d?.usage?.input_tokens;
    const output = d?.eval_count        ?? d?.usage?.completion_tokens ?? d?.usage?.output_tokens;
    if (typeof input === "number" && typeof output === "number") {
      return { input, output };
    }
  } catch { /* non-JSON or unexpected shape */ }
  return null;
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

  // 1b. If the publisher hasn't connected a backend yet (CLI-first flow where
  //     they publish on-chain first, then run the CLI to set the tunnel URL),
  //     reject early with a helpful message instead of a cryptic 502.
  if (!proxyConfig.backendUrl) {
    return c.json({
      error: `Endpoint #${endpointId} is registered but not yet connected to a backend. The publisher needs to run: npx @agentgate/cli tunnel --token <token>`,
      status: "pending_connection",
    }, 503);
  }

  // 1c. Concurrency gate — reject over-capacity BEFORE any payment processing
  //     so callers are never charged when the publisher's backend is saturated.
  //     A small retry window (3s) is communicated via Retry-After so polite
  //     clients back off without hammering.
  const maxConcurrent = proxyConfig.maxConcurrent;
  if (!acquireSlot(endpointId, maxConcurrent)) {
    const current = inFlightByEndpoint.get(endpointId) ?? 0;
    console.log(`[proxy] 🚦 Endpoint #${endpointId} at capacity (${current}/${maxConcurrent}) — rejecting with 429`);
    c.header("Retry-After", "3");
    return c.json({
      error: `Endpoint at capacity (${current}/${maxConcurrent} concurrent). Retry in a few seconds — you were NOT charged.`,
      retryAfterSeconds: 3,
      maxConcurrent,
    }, 429);
  }

  try {
    return await handleProxyRequest(c, endpointId, proxyConfig);
  } finally {
    releaseSlot(endpointId);
  }
});

/**
 * Core proxy logic. Extracted into its own function so the router can wrap the
 * whole thing in try/finally for the concurrency slot release.
 */
async function handleProxyRequest(c: any, endpointId: number, proxyConfig: any): Promise<Response> {
  const paymentTimeoutSeconds =
    proxyConfig.paymentTimeoutSeconds ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS;

  // 2. Read endpoint from chain to get price + publisher address
  //    Uses a short-lived in-memory cache to avoid a viem round-trip on
  //    every single paid call — saves ~0.5-1.5s per request.
  let priceUsd = 0.01; // fallback (registry stores USD, 6 decimals)
  let publisherAddress = PLATFORM_WALLET;
  let onChainRequireWorldId = false;

  const cached = getCachedEndpoint(endpointId);
  if (cached) {
    if (!cached.active) return c.json({ error: "Endpoint is inactive" }, 403);
    priceUsd = cached.priceUsd;
    publisherAddress = cached.publisherAddress;
    onChainRequireWorldId = cached.requireWorldId;
  } else {
    try {
      const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
      const ep = await client.readContract({
        address: REGISTRY, abi: REGISTRY_ABI,
        functionName: "endpoints", args: [BigInt(endpointId)],
      }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint, boolean];

      const active = ep[5];
      const freshPrice = Number(ep[3]) / 1_000_000;
      const freshPublisher = ep[1];
      const freshRequireWorldId = ep[9];

      // Cache even inactive state — we still want to reject with 403 quickly
      // on subsequent calls without another RPC hit.
      endpointChainCache.set(endpointId, {
        priceUsd: freshPrice,
        publisherAddress: freshPublisher,
        requireWorldId: freshRequireWorldId,
        active,
        cachedAt: Date.now(),
      });

      if (!active) return c.json({ error: "Endpoint is inactive" }, 403);
      priceUsd = freshPrice;
      publisherAddress = freshPublisher;
      onChainRequireWorldId = freshRequireWorldId;
    } catch (err: any) {
      console.warn(`[proxy] Could not read endpoint #${endpointId} from chain:`, err.message);
    }
  }

  // Use on-chain requireWorldId (falls back to proxyStore config)
  const requireWorldId = onChainRequireWorldId || proxyConfig.requireWorldId;

  // ── Per-token pricing pre-processing ──────────────────────────────────────
  // When the endpoint uses the per-token pricing model, we OVERRIDE priceUsd
  // with a budget derived from (estimated input tokens + maxOutputTokens).
  // We also read the request body once, inject a num_predict cap to enforce
  // the output budget upstream, and pass the mutated body to forwardToUpstream.
  //
  // This runs BEFORE payment verification because the 402 challenge must
  // advertise the correct amount to the buyer. For non-JSON or non-chat
  // bodies the override falls back to raw-length estimation.
  const isPerToken = proxyConfig.pricingModel === "per-token";
  let upstreamBodyOverride: Uint8Array | undefined;
  let estimatedInputTokens = 0;
  const perTokenMaxOutput = proxyConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const perTokenMaxInput  = proxyConfig.maxInputTokens  ?? DEFAULT_MAX_INPUT_TOKENS;
  const perTokenRate      = proxyConfig.pricePerMillionTokens ?? DEFAULT_PRICE_PER_MILLION_TOKENS;

  if (isPerToken && c.req.method !== "GET" && c.req.method !== "HEAD") {
    try {
      const rawBuf = await c.req.arrayBuffer();
      const rawText = new TextDecoder().decode(rawBuf);
      let parsed: any = null;
      try { parsed = JSON.parse(rawText); } catch { /* non-JSON body */ }

      estimatedInputTokens = estimateInputTokens(parsed, rawText);
      if (estimatedInputTokens > perTokenMaxInput) {
        return c.json({
          error: `Input too large: ~${estimatedInputTokens} estimated tokens exceeds this endpoint's cap of ${perTokenMaxInput}. Shorten your prompt or messages.`,
          estimatedInputTokens,
          maxInputTokens: perTokenMaxInput,
        }, 413);
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Inject output cap. We support the two dominant shapes:
        //   Ollama / OpenAI-compatible: `options.num_predict`
        //   OpenAI chat completions:    `max_tokens`
        //   Anthropic messages:         `max_tokens`
        const opts = parsed.options = parsed.options || {};
        const requestedOpts = typeof opts.num_predict === "number" ? opts.num_predict : perTokenMaxOutput;
        opts.num_predict = Math.min(requestedOpts, perTokenMaxOutput);
        if (typeof parsed.max_tokens === "number") {
          parsed.max_tokens = Math.min(parsed.max_tokens, perTokenMaxOutput);
        }
        upstreamBodyOverride = new TextEncoder().encode(JSON.stringify(parsed));
      } else {
        upstreamBodyOverride = new Uint8Array(rawBuf);
      }

      // Override priceUsd with the token-budget-based amount.
      const maxTotalTokens = estimatedInputTokens + perTokenMaxOutput;
      priceUsd = (maxTotalTokens / 1_000_000) * perTokenRate;
      console.log(
        `[proxy] 💰 per-token #${endpointId}: ~${estimatedInputTokens} in + up to ${perTokenMaxOutput} out ` +
        `@ $${perTokenRate}/1M = $${priceUsd.toFixed(6)} max`
      );
    } catch (err: any) {
      console.warn(`[proxy] per-token pre-read failed for #${endpointId}:`, err?.message || err);
      // Fall through with on-chain priceUsd — safer than 500ing the caller
    }
  }

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
        resource: c.req.url, description: proxyConfig.name, maxTimeoutSeconds: paymentTimeoutSeconds,
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
      maxTimeoutSeconds: paymentTimeoutSeconds,
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

      // For webpage endpoints we also override the displayed name: the
      // stored `name` field may be the backend hostname (auto-derived at
      // publish time on older versions of the form), which would also
      // leak the URL. Fall back to "Endpoint #N" whenever the stored name
      // happens to include a dot — that's a strong signal it's a hostname.
      const isWebpageMode = proxyConfig.contentType === "webpage";
      const storedName = proxyConfig.name || "";
      const displayName =
        isWebpageMode && /\./.test(storedName)
          ? `Endpoint #${endpointId}`
          : storedName || `Endpoint #${endpointId}`;

      const html = paywallHtml({
        endpointId,
        endpointName: displayName,
        priceUsd,
        usdcAmount: amount,
        payTo: PLATFORM_WALLET,
        backendUrl: proxyConfig.backendUrl,
        requireWorldId,
        proxyUrl: absUrl,
        contentType: proxyConfig.contentType,
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
  //    IMPORTANT: verify is purely validation — it does NOT move USDC.
  //    The actual on-chain transfer happens later via facilitator.settle().
  //    This two-phase flow lets us deliver-then-settle, so buyers never pay
  //    for failed upstream calls.
  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    return c.json({ error: "Invalid PAYMENT-SIGNATURE header (not base64 JSON)" }, 400);
  }

  const amount         = usdToUsdcUnits(priceUsd);
  const requirements   = { scheme: "exact", network: "eip155:84532", payTo: PLATFORM_WALLET, maxAmountRequired: amount, amount, asset: USDC_ADDRESS, extra: { name: "USDC", version: "2", decimals: 6, assetTransferMethod: "permit2" }, maxTimeoutSeconds: paymentTimeoutSeconds, resource: c.req.url };

  let verifyResult: any;
  try {
    verifyResult = await facilitator.verify(paymentPayload, requirements as any);
  } catch (verifyErr: any) {
    // VerifyError or network failure — surface as 402 with the reason, not
    // 500. A malformed payload or missing x402Version lands here.
    const reason = verifyErr?.invalidReason || verifyErr?.invalidMessage || verifyErr?.message || "unknown";
    console.warn(`[proxy] Verify threw for endpoint #${endpointId}: ${reason}`);
    return c.json({ error: `Payment verification failed: ${reason}` }, 402);
  }

  if (!verifyResult?.isValid) {
    console.warn(`[proxy] Payment invalid for endpoint #${endpointId}: ${verifyResult?.invalidReason}`);
    return c.json({ error: `Payment invalid: ${verifyResult?.invalidReason || "unknown"}` }, 402);
  }

  const platformFee = priceUsd * (PLATFORM_FEE_PCT / 100);
  const publisherNet = priceUsd - platformFee;
  console.log(`[proxy] ✅ Payment authorized for endpoint #${endpointId}: $${priceUsd} total → $${publisherNet.toFixed(4)} publisher + $${platformFee.toFixed(4)} platform (${PLATFORM_FEE_PCT}%) — will settle on delivery`);

  // 7. Forward to upstream and BUFFER the complete response in memory.
  //    forwardToUpstream already reads the body to arrayBuffer, so by the
  //    time it returns the entire response is captured. We hold it here
  //    and decide whether to actually deliver it based on settle success.
  //    For per-token endpoints we pass the pre-mutated body (with the
  //    injected num_predict cap) so the upstream can't exceed the budget.
  const upstreamResponse = await forwardToUpstream(c, proxyConfig, endpointId, upstreamBodyOverride);

  // 8. Delivery check — only settle if upstream actually succeeded.
  //    Upstream 4xx/5xx means the buyer got no value → return the error
  //    without settling, so the buyer is NOT charged.
  if (upstreamResponse.status >= 400) {
    console.warn(`[proxy] Upstream returned ${upstreamResponse.status} — NOT settling, buyer not charged`);
    return upstreamResponse;
  }

  // 9. Settle the payment on-chain BEFORE returning the response to the buyer.
  //    This is the security guarantee the user asked for: the buyer cannot
  //    "receive the response and then cancel the payment", because they
  //    never see the response until settle() has returned success.
  //
  //    The buffered response sits in memory during settlement (~0.5-2s).
  //    If settle fails, we return an error to the buyer instead of the
  //    response they paid for — the response is discarded. This is a
  //    deliberate trade-off: publisher absorbs the work cost rather than
  //    the buyer getting free inference.
  let settleResult: any;
  try {
    settleResult = await facilitator.settle(paymentPayload, requirements as any);
  } catch (settleErr: any) {
    console.error(`[proxy] ❌ Settle THREW after successful upstream: ${settleErr.message}`);
    return c.json({
      error: "Payment settlement failed after service delivery. You were NOT charged. Please retry.",
      details: settleErr.message,
    }, 502);
  }

  if (!settleResult?.success) {
    console.error(`[proxy] ❌ Settle returned failure: ${settleResult?.errorReason || "unknown"}`);
    return c.json({
      error: "Payment settlement failed. You were NOT charged. Please retry.",
      details: settleResult?.errorReason || "unknown",
    }, 402);
  }

  console.log(`[proxy] 💰 Settled #${endpointId}: tx ${settleResult.transaction} on ${settleResult.network}`);
  callTracker.record(endpointId, worldIdAddress || "unknown", false, priceUsd, PLATFORM_FEE_PCT);

  // 10. For per-token endpoints, peek at the response body to extract ACTUAL
  //     token usage (prompt_eval_count / eval_count for Ollama, usage.* for
  //     OpenAI/Anthropic). We log the delta vs the budget the buyer paid for.
  //     This is observability only — the buyer has already paid the MAX
  //     because we're on the `exact` scheme. When we later migrate to `upto`
  //     with a self-hosted facilitator, these numbers become the settle amount.
  //
  //     Reading the body consumes the Response stream, so we rebuild a fresh
  //     Response with the same bytes/status/headers for the buyer.
  if (isPerToken) {
    try {
      const bodyText = await upstreamResponse.text();
      const usage = parseUsageFromResponse(bodyText);
      if (usage) {
        const actualPrice = ((usage.input + usage.output) / 1_000_000) * perTokenRate;
        const overpay = priceUsd - actualPrice;
        console.log(
          `[proxy] 📊 #${endpointId} actual usage: ${usage.input} in + ${usage.output} out = ` +
          `$${actualPrice.toFixed(6)} real (buyer paid $${priceUsd.toFixed(6)} max, ` +
          `$${overpay.toFixed(6)} overpay margin)`
        );
      } else {
        console.log(`[proxy] 📊 #${endpointId} no usage field in response (non-JSON or unknown shape)`);
      }
      return new Response(bodyText, {
        status: upstreamResponse.status,
        headers: Object.fromEntries(upstreamResponse.headers.entries()),
      });
    } catch (err: any) {
      console.warn(`[proxy] per-token usage parse failed for #${endpointId}:`, err?.message || err);
      // If we can't parse/reconstruct, fall through to the default path.
    }
  }

  // 11. Now — and only now — deliver the buffered response to the buyer.
  return upstreamResponse;
}

export default router;
