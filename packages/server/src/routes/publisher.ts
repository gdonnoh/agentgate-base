import { Hono } from "hono";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { defineChain } from "viem";
import { randomBytes } from "crypto";
import {
  proxyStore,
  callTracker,
  hiddenEndpoints,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_PAYMENT_TIMEOUT_SECONDS,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_PRICING_MODEL,
  DEFAULT_PRICE_PER_MILLION_TOKENS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_ALLOWED_INPUT_TOKENS,
  MAX_ALLOWED_OUTPUT_TOKENS,
  MIN_MAX_CONCURRENT,
  MAX_MAX_CONCURRENT,
  MIN_PAYMENT_TIMEOUT_SECONDS,
  MAX_PAYMENT_TIMEOUT_SECONDS,
  type ContentType,
  type PricingModel,
} from "../services/proxyStore";
import { getLivenessSummary, probeEndpointNow } from "../services/liveness";
import { validateBackendUrl } from "../services/urlValidator";

const BASE_SEPOLIA_RPC = process.env.RPC_URL || "https://sepolia.base.org";
const REGISTRY    = (process.env.PUBLISHER_REGISTRY || "0xD1Dc9293031DB577F8f39817C35deA9Fc8024456") as `0x${string}`;

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

/**
 * Fetch the on-chain URL for `endpointId` and assert the given backend URL
 * matches on both hostname AND pathname. This prevents two separate attacks:
 *
 *   1) Hostname divergence — buyer sees example.com on-chain, proxy forwards
 *      to attacker.com. Breaks the "what you see is what you get" contract.
 *   2) Path divergence — buyer sees /api/weather on-chain, proxy forwards to
 *      /admin on the same host. Still lets a compromised server redirect
 *      traffic into an unrelated path on the publisher's own origin.
 *
 * Escape hatch: when the on-chain URL is empty (CLI-first flow — the endpoint
 * was registered without a URL because the publisher planned to connect later
 * via the tunnel token) we allow the operation to proceed. Otherwise we'd
 * deadlock the headless-publisher workflow.
 *
 * Throws { message, status } on mismatch so callers can forward it to the HTTP
 * response directly.
 */
async function assertUrlMatchesOnChain(
  endpointId: number,
  backendUrl: string,
): Promise<void> {
  const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
  const ep = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI,
    functionName: "endpoints", args: [BigInt(endpointId)],
  }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint, boolean];

  const onChainUrl = ep[2];
  // Empty on-chain URL = CLI-first flow where the publisher deferred the URL
  // until tunnel-connect time. Allow through.
  if (!onChainUrl) return;

  let backendHost: string, backendPath: string;
  let onChainHost: string, onChainPath: string;
  try {
    const b = new URL(backendUrl);
    backendHost = b.hostname.toLowerCase();
    backendPath = b.pathname || "/";
  } catch {
    const err: any = new Error(`Invalid backendUrl: "${backendUrl}"`);
    err.status = 400;
    throw err;
  }
  try {
    const o = new URL(onChainUrl);
    onChainHost = o.hostname.toLowerCase();
    onChainPath = o.pathname || "/";
  } catch {
    // On-chain URL is malformed — can't enforce a match. Log and let through
    // so a bad legacy row doesn't brick publishing; the SSRF guard still
    // protects us from obviously bad hosts.
    console.warn(`[proxy-config] On-chain URL for endpoint #${endpointId} is malformed: "${onChainUrl}" — skipping match check`);
    return;
  }

  if (backendHost !== onChainHost) {
    const err: any = new Error(
      `backendUrl hostname "${backendHost}" does not match the on-chain endpoint URL hostname "${onChainHost}". Update the on-chain registry entry first or use a matching host.`,
    );
    err.status = 400;
    throw err;
  }

  // Path comparison — normalise trailing slashes so "/api/weather" and
  // "/api/weather/" compare equal. Allow the tunnel path to be a subpath of
  // the on-chain path (e.g. on-chain /api, tunnel /api/v2) but NOT the
  // reverse — that's the "registered /api/weather, tunnel /admin" case.
  const normB = backendPath.replace(/\/+$/, "") || "/";
  const normO = onChainPath.replace(/\/+$/, "") || "/";
  const isSubpath = normO === "/" || normB === normO || normB.startsWith(normO + "/");
  if (!isSubpath) {
    const err: any = new Error(
      `backendUrl pathname "${backendPath}" does not match the on-chain endpoint URL pathname "${onChainPath}". The tunnel path must equal or extend the registered path — buyers saw "${onChainPath}", you cannot silently redirect them elsewhere on the same host.`,
    );
    err.status = 400;
    throw err;
  }
}

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
 * POST /api/publisher/proxy-config/set-tunnel
 *
 * Called by the @agentgate/cli `tunnel` command. The CLI starts a cloudflared
 * tunnel, gets a public URL, and POSTs it here so the proxy knows where to
 * forward paid calls. Auth is via the tunnel token generated at publish time
 * — no wallet signature required, making the CLI headless-friendly.
 *
 * Body: { token: string, tunnelUrl: string }
 */
// ── Tunnel nonce replay buffer (R2-E) ───────────────────────────────────────
// Per-endpoint ring of recently-seen nonces to reject replays within the
// token-rotation gap. Bounded at 100 entries so attackers can't blow up
// memory by flooding distinct nonces.
const TUNNEL_NONCES_MAX = 100;
const recentTunnelNonces = new Map<number, string[]>();
function rememberNonce(endpointId: number, nonce: string): boolean {
  const list = recentTunnelNonces.get(endpointId) || [];
  if (list.includes(nonce)) return false;
  list.push(nonce);
  while (list.length > TUNNEL_NONCES_MAX) list.shift();
  recentTunnelNonces.set(endpointId, list);
  return true;
}

/**
 * Shape the CLI sends in the optional `detected` field. Typed loosely here
 * because we never trust it wholesale — every field is validated + clamped
 * below before it's merged into the stored config.
 */
interface DetectedBody {
  contentType?: unknown;
  pricingModel?: unknown;
  allowedPaths?: unknown;
  model?: unknown;
  contextLength?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  pricePerMillionTokens?: unknown;
  maxConcurrent?: unknown;
  paymentTimeoutSeconds?: unknown;
}

/**
 * Normalize + validate the auto-detected config the CLI pushes. Returns null
 * when the input is missing or entirely garbage so the caller can skip the
 * merge. Each numeric field is clamped to the same range as the explicit
 * publish form to avoid surprise "detected 50000 tokens" blowups.
 *
 * The CLI maps to this server's wire format: "perToken" (CLI) → "per-token"
 * (server), "per-call" left alone. This is the ONLY place the conversion
 * happens so the CLI stays convention-friendly.
 */
function normalizeDetected(raw: unknown): {
  contentType: ContentType;
  pricingModel: PricingModel;
  allowedPaths?: string[];
  model?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  pricePerMillionTokens?: number;
  maxConcurrent: number;
  paymentTimeoutSeconds: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as DetectedBody;

  const contentType: ContentType = d.contentType === "webpage" ? "webpage" : "api";
  const pricingModel: PricingModel =
    d.pricingModel === "per-token" || d.pricingModel === "perToken" ? "per-token" : "per-call";

  let allowedPaths: string[] | undefined;
  if (Array.isArray(d.allowedPaths)) {
    const cleaned = d.allowedPaths
      .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length < 256)
      .slice(0, 32);
    if (cleaned.length > 0) allowedPaths = cleaned;
  }

  const model =
    typeof d.model === "string" && d.model.length > 0 && d.model.length < 256
      ? d.model
      : undefined;

  const clampNum = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };

  const maxInputTokens  = clampNum(d.maxInputTokens,  1, MAX_ALLOWED_INPUT_TOKENS);
  const maxOutputTokens = clampNum(d.maxOutputTokens, 1, MAX_ALLOWED_OUTPUT_TOKENS);

  const priceRaw = Number(d.pricePerMillionTokens);
  const pricePerMillionTokens =
    Number.isFinite(priceRaw) && priceRaw > 0 ? Math.min(10000, priceRaw) : undefined;

  const maxConcurrent =
    clampNum(d.maxConcurrent, MIN_MAX_CONCURRENT, MAX_MAX_CONCURRENT) ?? DEFAULT_MAX_CONCURRENT;
  const paymentTimeoutSeconds =
    clampNum(d.paymentTimeoutSeconds, MIN_PAYMENT_TIMEOUT_SECONDS, MAX_PAYMENT_TIMEOUT_SECONDS)
    ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS;

  return {
    contentType,
    pricingModel,
    allowedPaths,
    model,
    maxInputTokens,
    maxOutputTokens,
    pricePerMillionTokens,
    maxConcurrent,
    paymentTimeoutSeconds,
  };
}

router.post("/proxy-config/set-tunnel", async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { token, tunnelUrl, detected: detectedRaw } = body;
  if (!token || typeof token !== "string") {
    return c.json({ error: "Missing token" }, 400);
  }
  if (!tunnelUrl || typeof tunnelUrl !== "string") {
    return c.json({ error: "Missing tunnelUrl" }, 400);
  }

  // Validate URL format + SSRF guard (reject private/loopback/metadata hosts)
  try { new URL(tunnelUrl); } catch {
    return c.json({ error: `Invalid tunnelUrl: "${tunnelUrl}"` }, 400);
  }
  try { validateBackendUrl(tunnelUrl); } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  // Look up the endpoint by tunnel token
  const config = proxyStore.getByTunnelToken(token);
  if (!config) {
    return c.json({ error: "Invalid or expired tunnel token" }, 403);
  }

  // Hostname + pathname match check against the on-chain endpoint URL.
  // Same guarantee as POST /proxy-config — the tunnel can't silently point
  // buyers at a host or path that wasn't registered on-chain. Empty on-chain
  // URL is the documented escape hatch for the CLI-first flow (the publisher
  // registered without a URL and is setting it now).
  try {
    await assertUrlMatchesOnChain(config.endpointId, tunnelUrl);
  } catch (err: any) {
    const status = (err && typeof err.status === "number") ? err.status : 500;
    const message = (err && err.message) || `Could not verify tunnel URL against on-chain registry`;
    return c.json({ error: message }, status === 400 ? 400 : 500);
  }

  // ── Nonce replay protection (R2-E) ──
  // Require callers to include an X-Tunnel-Nonce. We keep the last 100
  // nonces per endpoint so the same body can't be replayed. Optional for
  // backwards compatibility with very old CLI builds — if absent we skip
  // the check but log a warning. After the CLI rollout this should become
  // mandatory.
  const nonce = c.req.header("x-tunnel-nonce") || c.req.header("X-Tunnel-Nonce");
  if (nonce) {
    if (!rememberNonce(config.endpointId, String(nonce))) {
      console.warn(`[proxy-config] ⛔  Replayed tunnel nonce for endpoint #${config.endpointId}`);
      return c.json({ error: "Tunnel nonce already used" }, 403);
    }
  } else {
    console.warn(`[proxy-config] set-tunnel called without X-Tunnel-Nonce for endpoint #${config.endpointId}`);
  }

  // ── Rotate the tunnel token (R2-E) ──
  // Generate a new token and persist it atomically with the backendUrl
  // update. The CLI must store this value and use it on the next call;
  // the old token is immediately invalid, so a stolen token can only be
  // used once before being replaced.
  const nextToken = `agt_${randomBytes(24).toString("base64url")}`;

  // ── Auto-detected config (Option A) ──
  // CLI push is authoritative — use dashboard overrides only if you never
  // run the CLI again. We simply overwrite the detected fields on every
  // connect. That keeps the mental model obvious ("whatever the CLI last
  // saw is what's live") and avoids a per-field dirty-tracking matrix.
  const normalizedDetected = normalizeDetected(detectedRaw);
  const now = Date.now();

  const updated: typeof config = {
    ...config,
    backendUrl: tunnelUrl,
    tunnelToken: nextToken,
    tunnelTokenUsedAt: now,
  };

  if (normalizedDetected) {
    updated.contentType = normalizedDetected.contentType;
    updated.pricingModel = normalizedDetected.pricingModel;
    updated.maxConcurrent = normalizedDetected.maxConcurrent;
    updated.paymentTimeoutSeconds = normalizedDetected.paymentTimeoutSeconds;
    if (normalizedDetected.allowedPaths) updated.allowedPaths = normalizedDetected.allowedPaths;
    // Per-token fields only make sense when pricingModel is "per-token";
    // for "per-call" we leave them on the config untouched so switching
    // back later doesn't lose the old values.
    if (normalizedDetected.pricingModel === "per-token") {
      if (normalizedDetected.pricePerMillionTokens !== undefined) {
        updated.pricePerMillionTokens = normalizedDetected.pricePerMillionTokens;
      }
      if (normalizedDetected.maxInputTokens !== undefined) {
        updated.maxInputTokens = normalizedDetected.maxInputTokens;
      }
      if (normalizedDetected.maxOutputTokens !== undefined) {
        updated.maxOutputTokens = normalizedDetected.maxOutputTokens;
      }
    }
    // Use the model name as the display name if the publisher never picked
    // one — purely cosmetic, safe to default.
    if (normalizedDetected.model && (!config.name || config.name.startsWith("Endpoint #"))) {
      updated.name = normalizedDetected.model;
    }
    updated.detectedAt = now;
  }

  proxyStore.set(updated);

  console.log(
    `[proxy-config] 🔗 Endpoint #${config.endpointId} tunnel updated → ${tunnelUrl}` +
    ` (token rotated${normalizedDetected ? `, auto-detected config applied` : ""})`
  );
  return c.json({
    ok: true,
    endpointId: config.endpointId,
    proxyUrl: `/api/proxy/${config.endpointId}`,
    backendUrl: tunnelUrl,
    nextToken,
    detected: normalizedDetected,
  });
});

/**
 * POST /api/publisher/test-backend
 *
 * Lightweight backend reachability check. The dashboard calls this BEFORE
 * publishing so the user knows their backend URL works BEFORE paying the
 * 1 USDC on-chain fee. The server does the HEAD from its side (not the
 * browser) to avoid CORS issues and to test the SAME network path the
 * proxy will use later.
 *
 * Body: { backendUrl: string, injectHeaders?: Record<string, string> }
 * No wallet signature needed — this is a read-only health probe.
 */
router.post("/test-backend", async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { backendUrl, injectHeaders } = body;
  if (!backendUrl || typeof backendUrl !== "string") {
    return c.json({ error: "Missing backendUrl" }, 400);
  }

  // Validate URL format + SSRF guard
  try { new URL(backendUrl); } catch {
    return c.json({ error: `Invalid URL: "${backendUrl}". Must start with https:// or http://` }, 400);
  }
  try { validateBackendUrl(backendUrl); } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  const t0 = Date.now();
  try {
    const testHeaders: Record<string, string> = {};
    if (injectHeaders && typeof injectHeaders === "object") {
      for (const [k, v] of Object.entries(injectHeaders)) {
        testHeaders[k.toLowerCase()] = String(v);
      }
    }
    const res = await fetch(backendUrl, {
      method: "HEAD",
      headers: testHeaders,
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - t0;
    // 4xx = server is responsive (auth issues are fine for a health check)
    // 5xx = genuinely broken
    if (res.status >= 500) {
      return c.json({
        error: `Backend returned HTTP ${res.status}. The server is up but returning an error.`,
        status: res.status,
        latencyMs,
      }, 422);
    }
    return c.json({ ok: true, status: res.status, latencyMs });
  } catch (err: any) {
    const latencyMs = Date.now() - t0;
    return c.json({
      error: err?.name === "TimeoutError"
        ? `Backend timed out after 10s. Is the URL correct and the service running?`
        : `Backend unreachable: ${err?.message || err}`,
      latencyMs,
    }, 422);
  }
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

  if (endpointId === undefined || !walletAddress || !signature || !timestamp) {
    return c.json({ error: "Missing required fields: endpointId, walletAddress, signature, timestamp" }, 400);
  }
  // backendUrl is optional — if empty, the publisher plans to connect via
  // CLI later (set-tunnel route). We still save the config + generate a
  // tunnel token so the CLI has something to authenticate with.
  // When present, run it through the SSRF guard up-front so a bad URL is
  // rejected BEFORE we do any on-chain lookups or network probes.
  if (backendUrl) {
    try { validateBackendUrl(backendUrl); } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  }

  // 1. Check timestamp freshness (within 10 minutes)
  if (Math.abs(Date.now() - Number(timestamp)) > 10 * 60 * 1000) {
    return c.json({ error: "Signature timestamp expired (must be within 10 minutes)" }, 400);
  }

  // 2. Recover signer from EIP-191 signature.
  //    When backendUrl is empty (CLI-first flow), the client signs "(cli)"
  //    as the URL placeholder so the message is never ambiguous.
  const signedBackendUrl = backendUrl || "(cli)";
  const message = `AgentGate proxy config\nendpointId: ${endpointId}\nbackendUrl: ${signedBackendUrl}\ntimestamp: ${timestamp}`;
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (err: any) {
    return c.json({ error: `Invalid signature: ${err.message}` }, 400);
  }

  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    return c.json({ error: "Signature mismatch: recovered address does not match walletAddress" }, 403);
  }

  // 3. Read endpoint from chain — verify walletAddress is the publisher.
  //    Also verify the backendUrl hostname matches the URL the publisher
  //    committed on-chain. This prevents a compromised-server bypass where
  //    the proxy_config points somewhere unrelated to what buyers saw.
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

  // Hostname + pathname match check. Only enforced when backendUrl is set —
  // during the CLI-first flow (backendUrl=="") we haven't picked a host yet
  // and the helper's own empty-on-chain escape hatch handles legacy rows.
  if (backendUrl) {
    try {
      await assertUrlMatchesOnChain(Number(endpointId), backendUrl);
    } catch (err: any) {
      const status = (err && typeof err.status === "number") ? err.status : 500;
      const message = (err && err.message) || `Could not verify backendUrl against on-chain registry`;
      return c.json({ error: message }, status === 400 ? 400 : 500);
    }
  }

  // 4. Verify backend is reachable before accepting the config.
  //    Skip entirely if backendUrl is empty (CLI-first flow — the publisher
  //    will provide the URL later via the tunnel token + set-tunnel route).
  let backendVerified = !backendUrl; // empty URL = skip verification
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

  // Per-token pricing fields — only meaningful when pricingModel is "per-token".
  // We clamp rather than reject so older clients that don't know about the new
  // fields still publish successfully with defaults.
  const pricingModel: PricingModel =
    body.pricingModel === "per-token" ? "per-token" : DEFAULT_PRICING_MODEL;

  let pricePerMillionTokens: number | undefined;
  let maxInputTokens: number | undefined;
  let maxOutputTokens: number | undefined;

  if (pricingModel === "per-token") {
    const rawPrice = Number(body.pricePerMillionTokens);
    pricePerMillionTokens = Number.isFinite(rawPrice) && rawPrice > 0
      ? Math.min(10000, rawPrice) // hard cap at $10k/1M tokens — anything higher is a typo
      : DEFAULT_PRICE_PER_MILLION_TOKENS;

    const rawMaxIn = Number(body.maxInputTokens);
    maxInputTokens = Number.isFinite(rawMaxIn) && rawMaxIn > 0
      ? Math.min(MAX_ALLOWED_INPUT_TOKENS, Math.max(1, Math.floor(rawMaxIn)))
      : DEFAULT_MAX_INPUT_TOKENS;

    const rawMaxOut = Number(body.maxOutputTokens);
    maxOutputTokens = Number.isFinite(rawMaxOut) && rawMaxOut > 0
      ? Math.min(MAX_ALLOWED_OUTPUT_TOKENS, Math.max(1, Math.floor(rawMaxOut)))
      : DEFAULT_MAX_OUTPUT_TOKENS;
  }

  // Generate a tunnel token if this endpoint doesn't have one yet. The
  // token lets the CLI update the backendUrl (cloudflared tunnel URLs
  // change on restart) without needing a wallet signature. It's shown
  // once in the publish response and never again in public API routes.
  const existing = proxyStore.get(Number(endpointId));
  const tunnelToken = existing?.tunnelToken || `agt_${randomBytes(24).toString("base64url")}`;

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
    pricingModel,
    pricePerMillionTokens,
    maxInputTokens,
    maxOutputTokens,
    tunnelToken,
  });

  // Re-publishing an endpoint the publisher had previously hidden or
  // deleted should bring it back into view. Clear any hidden flag.
  hiddenEndpoints.unhide(Number(endpointId), walletAddress.toLowerCase());

  console.log(`[proxy-config] ✅ Endpoint #${endpointId} → ${backendUrl} (verified, by ${walletAddress})`);

  return c.json({
    success:  true,
    proxyUrl: `/api/proxy/${endpointId}`,
    verified: true,
    tunnelToken,
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
    pricingModel:   config.pricingModel,
    pricePerMillionTokens: config.pricePerMillionTokens,
    maxInputTokens:  config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
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
