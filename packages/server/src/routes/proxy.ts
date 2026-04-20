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
import { createHmac, createHash, randomUUID, timingSafeEqual } from "crypto";
import {
  proxyStore,
  callTracker,
  chatSessions,
  CHAT_SESSION_TTL_SECONDS,
  DEFAULT_PAYMENT_TIMEOUT_SECONDS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PRICE_PER_MILLION_TOKENS,
} from "../services/proxyStore";
import { validateAgentKitHeader } from "../services/agentkit";
import { config, USDC_ADDRESS } from "../config";
import { paywallHtml } from "../paywall";

// ── Session token signing (HMAC) ─────────────────────────────────────────────
// Sessions issued after a browser pays are bearer tokens the chat UI sends
// with every subsequent /api/chat call. We sign them with HMAC-SHA256 so the
// server can verify them without a DB round-trip when the signature is bad.
//
// SESSION_SECRET precedence:
//   1. process.env.SESSION_SECRET (recommended in production)
//   2. deterministic derivation from PRIVATE_KEY — lets self-hosted deploys
//      with no explicit secret still have a stable key across restarts.
// We warn once at startup if the env var is missing so operators notice.
const _envSessionSecret = process.env.SESSION_SECRET;
let _sessionSecretWarned = false;
function getSessionSecret(): string {
  if (_envSessionSecret && _envSessionSecret.length > 0) return _envSessionSecret;
  if (!_sessionSecretWarned) {
    _sessionSecretWarned = true;
    console.warn(
      "[proxy] ⚠  SESSION_SECRET not set — deriving from PRIVATE_KEY. " +
      "Set SESSION_SECRET explicitly in production for rotation safety."
    );
  }
  return createHash("sha256")
    .update("agentgate-session-" + (process.env.PRIVATE_KEY || ""))
    .digest("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface SessionTokenPayload {
  sid: string;
  endpointId: number;
  expiresAt: number;
}

function signSessionToken(payload: SessionTokenPayload): string {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac("sha256", getSessionSecret()).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verifySessionToken(token: string): SessionTokenPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSessionSecret()).update(body).digest("hex");
  // Constant-time compare — both sides are hex, same length when valid.
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return null;
  try {
    if (!timingSafeEqual(a, b)) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(base64urlDecode(body).toString("utf-8")) as SessionTokenPayload;
    if (typeof payload.sid !== "string" || typeof payload.endpointId !== "number"
        || typeof payload.expiresAt !== "number") return null;
    if (payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch { return null; }
}

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
const REGISTRY    = (process.env.PUBLISHER_REGISTRY || "0xD1Dc9293031DB577F8f39817C35deA9Fc8024456") as `0x${string}`;
const PLATFORM_WALLET = config.platformAddress as `0x${string}`;
const PLATFORM_FEE_PCT = config.platformFeePct;

// Browser direct-transfer tx-hash dedup lives in `proxyStore` (Postgres +
// in-memory hot cache). This local Set is no longer used — see FIX 3.

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

// ── Ollama path whitelist (R2-A) ─────────────────────────────────────────────
// When the proxy forwards a request it appends the request's path suffix to
// the backendUrl. Without validation this lets buyers reach /api/pull or
// /api/delete on a self-hosted Ollama, which are admin endpoints. We allow
// only the inference + OpenAI-compatible paths. Empty suffix is allowed iff
// the backend already includes a full path (e.g. upstream points at
// https://host/api/chat directly) — we detect that by checking backendUrl
// already ends with one of the allowed endpoints.
const DEFAULT_ALLOWED_PATHS = [
  "/api/chat",
  "/api/generate",
  "/api/embeddings",
  "/api/embed",
  "/v1/",     // OpenAI-compatible: /v1/chat/completions, /v1/embeddings, etc.
];

// Explicitly-blocked admin suffixes. These are the Ollama management paths
// that would let a buyer pull/push/delete models or exfiltrate Modelfile
// contents via /api/show. Anything on this list is rejected in both the
// pre-payment gate and the post-payment forward step.
const BLOCKED_ADMIN_SUFFIXES = [
  "/api/show",
  "/api/pull",
  "/api/push",
  "/api/delete",
  "/api/create",
  "/api/copy",
  "/api/tags",
  "/api/blobs",
];

function matchesAdminSuffix(suffix: string): boolean {
  for (const bad of BLOCKED_ADMIN_SUFFIXES) {
    if (suffix === bad || suffix.startsWith(bad + "/")) return true;
  }
  return false;
}

/** Return true if the suffix is allowed by the endpoint's whitelist.
 *  `suffix` is what we'd append to backendUrl (starts with "/" or is "").
 *
 *  Empty/root suffix is ALWAYS allowed: a bare GET /api/proxy/:id hits the
 *  backend root which is harmless (Ollama root just replies "Ollama is
 *  running") and we need this to return the 402 challenge + browser paywall
 *  page to probing clients. Admin suffixes from BLOCKED_ADMIN_SUFFIXES are
 *  always rejected regardless of the allowlist. */
function isAllowedProxySuffix(
  suffix: string,
  _backendUrl: string,
  allowedPaths: string[] = DEFAULT_ALLOWED_PATHS,
): boolean {
  // Reject path traversal outright.
  if (suffix.includes("..")) return false;

  // Reject admin/management Ollama endpoints always.
  if (matchesAdminSuffix(suffix)) return false;

  // Empty or root suffix — harmless, always allow.
  if (suffix === "" || suffix === "/") return true;

  // Non-empty suffix must match the allowlist.
  for (const allowed of allowedPaths) {
    if (allowed.endsWith("/")) {
      if (suffix === allowed.slice(0, -1) || suffix.startsWith(allowed)) return true;
    } else {
      if (suffix === allowed || suffix.startsWith(allowed + "/")) return true;
    }
  }
  return false;
}

// ── Ollama body field whitelist (R2-C) ───────────────────────────────────────
// Prevent callers from injecting DoS parameters like `num_ctx: 999999` or
// pulling in unknown fields that upstream Ollama might forward to weird
// subsystems. Everything outside these sets is stripped silently.
const ALLOWED_BODY_FIELDS = new Set([
  "model", "messages", "prompt", "system",
  "options", "stream", "format", "template",
  // OpenAI / Anthropic compatibility — keep benign commonly-used fields.
  "max_tokens", "temperature", "top_p", "top_k", "stop", "seed",
  "presence_penalty", "frequency_penalty", "n",
]);
const ALLOWED_OPTIONS_FIELDS = new Set([
  "num_predict", "temperature", "top_k", "top_p",
  "repeat_penalty", "seed", "stop",
]);

function sanitizeRequestBody(parsed: any): any {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const out: any = {};
  for (const k of Object.keys(parsed)) {
    if (!ALLOWED_BODY_FIELDS.has(k)) continue;
    if (k === "options" && parsed.options && typeof parsed.options === "object") {
      const filtered: any = {};
      for (const ok of Object.keys(parsed.options)) {
        if (ALLOWED_OPTIONS_FIELDS.has(ok)) filtered[ok] = parsed.options[ok];
      }
      out.options = filtered;
    } else {
      out[k] = parsed[k];
    }
  }
  return out;
}

// ── Upstream response size cap (R2-B) ────────────────────────────────────────
const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

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

  const rawPath  = c.req.path;
  const suffix   = rawPath.replace(new RegExp(`^/api/proxy/${endpointId}`), "");

  // ── Path whitelist (R2-A) ──
  // Reject admin / management Ollama paths BEFORE doing any upstream work.
  const allowedPaths = Array.isArray(proxyConfig.allowedPaths) && proxyConfig.allowedPaths.length > 0
    ? proxyConfig.allowedPaths
    : DEFAULT_ALLOWED_PATHS;
  if (!isAllowedProxySuffix(suffix, proxyConfig.backendUrl, allowedPaths)) {
    console.warn(`[proxy] ⛔  Blocked path for endpoint #${endpointId}: "${suffix}"`);
    return c.json({ error: "Path not allowed" }, 403);
  }

  let bodyBuffer: ArrayBuffer | Uint8Array | undefined;
  if (bodyOverride !== undefined) {
    bodyBuffer = bodyOverride;
  } else if (method !== "GET" && method !== "HEAD") {
    // Read body and apply Ollama field whitelist (R2-C). We only sanitize
    // JSON bodies; everything else is forwarded as-is.
    const raw = await c.req.arrayBuffer();
    const ct = (c.req.header("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw));
        const sanitized = sanitizeRequestBody(parsed);
        bodyBuffer = new TextEncoder().encode(JSON.stringify(sanitized));
      } catch {
        bodyBuffer = raw; // non-JSON shaped body — pass through
      }
    } else {
      bodyBuffer = raw;
    }
  }

  const upstreamHeaders: Record<string, string> = {};
  const ct = c.req.header("content-type");
  if (ct) upstreamHeaders["content-type"] = ct;
  const accept = c.req.header("accept");
  if (accept) upstreamHeaders["accept"] = accept;

  for (const [k, v] of Object.entries(proxyConfig.injectHeaders as Record<string, string>)) {
    upstreamHeaders[k.toLowerCase()] = v;
  }

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

  // ── Response size cap (R2-B) ──
  // Layer 1: content-length check. Reject early if upstream declares a body
  // larger than our cap.
  const clHeader = upstreamRes.headers.get("content-length");
  if (clHeader) {
    const declared = Number(clHeader);
    if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
      console.warn(`[proxy] ⛔  Upstream declared ${declared} bytes for endpoint #${endpointId} — cap is ${MAX_UPSTREAM_RESPONSE_BYTES}`);
      return c.json({ error: "Upstream response too large" }, 413);
    }
  }

  // Layer 2: streaming byte counter. Abort the read if we exceed the cap
  // even when content-length wasn't set (chunked / streaming responses).
  const body = upstreamRes.body;
  let captured: Uint8Array;
  if (!body) {
    captured = new Uint8Array(0);
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          console.warn(`[proxy] ⛔  Upstream body exceeded ${MAX_UPSTREAM_RESPONSE_BYTES} bytes for endpoint #${endpointId}`);
          return c.json({ error: "Upstream response too large" }, 413);
        }
        chunks.push(value);
      }
    }
    captured = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      captured.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  const upCt = upstreamRes.headers.get("content-type") || "application/json";
  return new Response(captured, { status: upstreamRes.status, headers: { "content-type": upCt } });
}

/**
 * Convert USD price to USDC amount string (6 decimals).
 * e.g. $0.01 → "10000"
 */
function usdToUsdcUnits(usdAmount: number): string {
  return Math.ceil(usdAmount * 1_000_000).toString();
}

/**
 * Return the canonical absolute URL for the incoming request, honouring
 * `X-Forwarded-Proto` when we're behind a reverse proxy (Render, Cloudflare).
 *
 * `c.req.url` on a Node adapter can still be an `http://` URL even after TLS
 * termination at the edge, which would leak into the x402 402 challenge body
 * and trick clients into replaying payments against a plaintext URL. Prefer
 * the forwarded proto; otherwise pick https in production, http only in dev.
 *
 * SECURITY: the host is NEVER read from the `Host` request header. That
 * header is attacker-controllable and would otherwise end up signed into
 * x402 challenges ("resource" field) — giving an attacker a replayable
 * payment authorization for their own domain. We pin the host in this order:
 *
 *   1. env `PUBLIC_HOST` (authoritative — set this in prod to the canonical
 *      domain, e.g. `api.agentgate.xyz`).
 *   2. Parsed host from `c.req.url` (Hono-normalized URL the adapter gave us).
 *   3. "localhost:<port>" as a dev-only last resort.
 */
function resolveResourceUrl(c: any): string {
  const isDev = process.env.NODE_ENV !== "production";
  let pathname = "/";
  let search = "";
  let urlHost = "";
  try {
    const orig = new URL(c.req.url);
    pathname = orig.pathname;
    search = orig.search;
    urlHost = orig.host;
  } catch { /* fall through to env / default */ }

  const pinnedHost = (process.env.PUBLIC_HOST || "").trim();
  const host = pinnedHost || urlHost || `localhost:${process.env.PORT || 4021}`;

  const fwdProto = (c.req.header("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  const proto = fwdProto || (isDev && host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}${pathname}${search}`;
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
    // ── Session-authenticated chat path ──
    // Browser paywall issues a session token after the user pays; subsequent
    // /api/chat calls send it via `x-agentgate-session`. We ONLY accept the
    // /api/chat path for sessioned calls — everything else falls through to
    // the normal payment flow to minimise the session blast radius.
    const sessionHeader = c.req.header("x-agentgate-session");
    if (sessionHeader) {
      return await handleSessionedRequest(c, endpointId, proxyConfig, sessionHeader);
    }
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

  // ── Path whitelist pre-flight (R2-A) ──
  // Reject admin / management paths BEFORE any payment processing so callers
  // are never charged when their target is blocked. forwardToUpstream checks
  // this too as a defence-in-depth — the callers via the free-trial path also
  // must go through that gate.
  const rawPath0 = c.req.path;
  const suffix0  = rawPath0.replace(new RegExp(`^/api/proxy/${endpointId}`), "");
  const allowedPathsCfg = Array.isArray(proxyConfig.allowedPaths) && proxyConfig.allowedPaths.length > 0
    ? proxyConfig.allowedPaths
    : DEFAULT_ALLOWED_PATHS;
  if (proxyConfig.backendUrl && !isAllowedProxySuffix(suffix0, proxyConfig.backendUrl, allowedPathsCfg)) {
    console.warn(`[proxy] ⛔  Blocked path for endpoint #${endpointId}: "${suffix0}"`);
    return c.json({ error: "Path not allowed" }, 403);
  }

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
        // Apply top-level + options whitelist (R2-C) before re-encoding.
        const sanitized = sanitizeRequestBody(parsed);
        upstreamBodyOverride = new TextEncoder().encode(JSON.stringify(sanitized));
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
        resource: resolveResourceUrl(c), description: proxyConfig.name, maxTimeoutSeconds: paymentTimeoutSeconds,
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
      // Reject replays BEFORE we do any RPC work — cheap win.
      if (await proxyStore.isTxHashUsed(browserTxHash)) {
        return c.json({ error: "Payment tx already used" }, 402);
      }

      const client = createPublicClient({ chain: baseSepoliaChain, transport: http(BASE_SEPOLIA_RPC) });
      const receipt = await client.getTransactionReceipt({ hash: browserTxHash as `0x${string}` });

      if (receipt.status !== "success") {
        return c.json({ error: "Payment transaction failed on-chain" }, 402);
      }

      // Confirmation-depth check: a freshly-mined tx can be reorged away.
      // Require 2 confirmations (i.e. at least one block BEYOND the receipt
      // block) before we accept the payment. This is cheap because we already
      // have a client, and it drastically reduces the replay-after-reorg
      // attack window. On Base Sepolia 2s blocks make this ~4s of extra wait
      // in the worst case.
      const latest = await client.getBlockNumber();
      if (latest - receipt.blockNumber < 2n) {
        return c.json(
          {
            error: "Tx needs 2 confirmations — retry in a few seconds",
            txBlock: receipt.blockNumber.toString(),
            latestBlock: latest.toString(),
          },
          425 // "Too Early"
        );
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

      // Replay protection: persistent dedup via proxyStore (Postgres-backed
      // with an in-memory hot cache). The pre-flight check at the top of the
      // try block already covered this, but we re-check + mark here so the
      // "check" and "mark" sit right around the credit operation.
      if (await proxyStore.isTxHashUsed(browserTxHash)) {
        return c.json({ error: "Payment tx already used" }, 402);
      }
      await proxyStore.markTxHashUsed(browserTxHash);

      const platformFee = priceUsd * (PLATFORM_FEE_PCT / 100);
      const publisherNet = priceUsd - platformFee;
      console.log(`[proxy] ✅ Browser payment verified for #${endpointId}: $${priceUsd} via tx ${browserTxHash.slice(0, 12)}… ($${publisherNet.toFixed(4)} publisher + $${platformFee.toFixed(4)} platform)`);
      callTracker.record(endpointId, browserFrom, false, priceUsd, PLATFORM_FEE_PCT);

      // ── Chat-session issuance (root path only) ──
      // When the browser paid a root proxy URL we're not forwarding a specific
      // upstream request — the payment is to unlock the paywall. For API-mode
      // endpoints we issue a session token + render the in-browser chat UI.
      // Chat session is issued ONLY for per-token API endpoints — that's the
      // pricing model that matches the open-ended conversational UX. Per-call
      // API endpoints are stateless (weather, prices, one-shot lookups) and
      // fall through to the redirect/forward path below, which gives the buyer
      // the single upstream response they paid for. Webpage endpoints also
      // fall through — payment = single unlock.
      const isPerTokenApi = proxyConfig.contentType !== "webpage"
        && proxyConfig.pricingModel === "per-token";
      const suffixRaw = c.req.path.replace(new RegExp(`^/api/proxy/${endpointId}`), "");
      const isRootPath = suffixRaw === "" || suffixRaw === "/";
      if (isPerTokenApi && isRootPath) {
        const paidMicroUsdc = BigInt(usdToUsdcUnits(priceUsd));
        const sid = randomUUID();
        const session = await chatSessions.create(
          sid, endpointId, browserTxHash, proxyConfig.pricingModel,
          { microUsdc: paidMicroUsdc },
        );
        const sessionToken = signSessionToken({
          sid,
          endpointId,
          expiresAt: session.expiresAt,
        });
        const models = Array.isArray(proxyConfig.models) ? proxyConfig.models : [];

        return c.json({
          ok: true,
          sessionToken,
          expiresAt: session.expiresAt,
          pricingModel: proxyConfig.pricingModel,
          budget: { microUsdc: paidMicroUsdc.toString() },
          pricePerMillionTokens: proxyConfig.pricePerMillionTokens,
          models,
          endpointName: proxyConfig.name,
          ttlSeconds: CHAT_SESSION_TTL_SECONDS,
        });
      }

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
      resource: resolveResourceUrl(c),
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
      // Build absolute URL forcing https behind proxies (Render/Cloudflare).
      // SECURITY: do NOT trust the Host header — use resolveResourceUrl()
      // which pins the host to env PUBLIC_HOST or the adapter-parsed URL.
      // Otherwise the paywall page bakes an attacker-supplied host into
      // its self-links, which also flows into the x402 resource URL.
      const absUrl = resolveResourceUrl(c);

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
  const requirements   = { scheme: "exact", network: "eip155:84532", payTo: PLATFORM_WALLET, maxAmountRequired: amount, amount, asset: USDC_ADDRESS, extra: { name: "USDC", version: "2", decimals: 6, assetTransferMethod: "permit2" }, maxTimeoutSeconds: paymentTimeoutSeconds, resource: resolveResourceUrl(c) };

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

  // ── Bind AgentKit address to x402 payer (R2-D) ──
  // When both an `agentkit` header was verified AND an x402 payment signature
  // is present, require the two addresses to match. Otherwise a buyer could
  // use someone else's WorldID delegation to get WorldID-gated access while
  // paying from their own wallet (or vice versa). We probe the common x402 v2
  // payload paths for the payer address and log the payload shape if we can't
  // locate it, so production telemetry tightens this over time.
  if (worldIdVerified && worldIdAddress) {
    const auth = paymentPayload?.payload?.authorization ?? paymentPayload?.authorization ?? null;
    const payerAddress: string | undefined =
      auth?.from ?? auth?.owner ?? auth?.signer ??
      paymentPayload?.payload?.from ?? paymentPayload?.from;
    if (typeof payerAddress === "string" && payerAddress.length > 0) {
      if (worldIdAddress.toLowerCase() !== payerAddress.toLowerCase()) {
        console.warn(
          `[proxy] ⛔  AgentKit/payer mismatch for endpoint #${endpointId}: agentkit=${worldIdAddress} payer=${payerAddress}`
        );
        return c.json({ error: "AgentKit wallet must match payment signer" }, 403);
      }
    } else {
      // Payload shape unknown — warn so we can tighten this in a follow-up once
      // we've logged real-world payloads. Don't reject (avoid false positives).
      console.warn(
        `[proxy] agentkit/payer bind: could not locate payer address in payload; ` +
        `authorization keys=${auth ? Object.keys(auth).join(",") : "none"}`
      );
    }
  }

  // Belt-and-braces: facilitator.verify already enforces the requirements, but
  // we re-assert the `authorization.value >= maxAmountRequired` condition on
  // our side so a facilitator bug (or a swapped facilitator) can never let an
  // underpaid call through. x402 v2 puts the amount under
  //   paymentPayload.payload.authorization.value  (permit2 / EIP-3009)
  // Older shapes use `authorization.amount` or `payload.amount`. We probe a
  // few likely places and, if we find *a* number, assert it. If we can't find
  // it we log a TODO and move on (we'd rather err toward "accept" for known
  // payloads the facilitator already said are OK than reject valid calls).
  try {
    const auth = paymentPayload?.payload?.authorization ?? paymentPayload?.authorization ?? null;
    const rawAmount =
      auth?.value ?? auth?.amount ?? paymentPayload?.payload?.value ?? paymentPayload?.payload?.amount;
    if (rawAmount !== undefined && rawAmount !== null) {
      const paid = BigInt(rawAmount);
      const required = BigInt(requirements.maxAmountRequired || (requirements as any).amount);
      if (paid < required) {
        console.warn(`[proxy] Underpaid for endpoint #${endpointId}: paid=${paid} required=${required}`);
        return c.json(
          { error: `Payment amount ${paid} is less than required ${required}` },
          402
        );
      }
    } else {
      // TODO: once we've logged the real shape of x402 v2 payloads in prod,
      // tighten this to require a known field path rather than best-effort.
      console.warn(
        `[proxy] amount-assert: could not locate authorization.value in payload, skipping check. Payload keys: ${Object.keys(paymentPayload || {}).join(",")}`
      );
    }
  } catch (e: any) {
    console.warn(`[proxy] amount-assert threw for endpoint #${endpointId}: ${e?.message || e}`);
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

/**
 * Handle a request that came in with `x-agentgate-session`. The token was
 * issued by the paywall after a successful USDC payment. We verify the HMAC,
 * look the session up in the ledger, restrict the accepted path to /api/chat
 * only, forward to Ollama with stream forced off, then atomically decrement
 * the session budget based on actual token usage (per-token) or by 1 message
 * (per-call).
 *
 * Returns the upstream response verbatim plus two response headers the chat
 * UI uses to keep the counter live:
 *   x-session-remaining-micro-usdc  (per-token)
 *   x-session-remaining-messages    (per-call)
 *   x-session-expires-at            (ms-epoch)
 */
async function handleSessionedRequest(
  c: any,
  endpointId: number,
  proxyConfig: any,
  sessionHeader: string,
): Promise<Response> {
  // 1. Signature + expiry check (no DB round-trip on bad tokens).
  const payload = verifySessionToken(sessionHeader);
  if (!payload) {
    return c.json({ error: "Invalid session" }, 401);
  }
  if (payload.endpointId !== endpointId) {
    return c.json({ error: "Session does not match endpoint" }, 401);
  }

  // 2. Ledger lookup. A valid HMAC with a missing row means the session
  // was pruned / server data lost — treat as expired.
  const session = await chatSessions.get(payload.sid);
  if (!session) {
    return c.json({ error: "Session expired" }, 401);
  }

  // 3. Path whitelist. Sessions are ONLY valid for /api/chat — this is a
  //    DoS-minimisation measure: if a session token leaks we limit the
  //    surface area to the single endpoint the chat UI needs.
  const suffix = c.req.path.replace(new RegExp(`^/api/proxy/${endpointId}`), "");
  if (suffix !== "/api/chat") {
    return c.json({ error: "Session path not allowed" }, 403);
  }
  if (c.req.method !== "POST") {
    return c.json({ error: "Only POST /api/chat is supported for sessioned calls" }, 405);
  }

  // 4. Read + sanitize the body. We also force stream=false server-side so
  //    we can reliably parse the usage fields for per-token accounting.
  let parsed: any = null;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const sanitized = sanitizeRequestBody(parsed) || {};
  sanitized.stream = false;
  const bodyBuffer = new TextEncoder().encode(JSON.stringify(sanitized));

  // 5. Build upstream request.
  const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(proxyConfig.injectHeaders as Record<string, string>)) {
    upstreamHeaders[k.toLowerCase()] = v;
  }
  const upstream = proxyConfig.backendUrl.replace(/\/$/, "") + "/api/chat";

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyBuffer,
    });
  } catch (err: any) {
    return c.json({ error: `Upstream error: ${err?.message || String(err)}` }, 502);
  }

  // 6. Read upstream body (bounded by the same cap the paid path uses).
  const bodyText = await upstreamRes.text();
  if (bodyText.length > MAX_UPSTREAM_RESPONSE_BYTES) {
    return c.json({ error: "Upstream response too large" }, 413);
  }

  // 7. Don't charge for upstream failures.
  if (upstreamRes.status >= 400) {
    return new Response(bodyText, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json" },
    });
  }

  // 8. Decrement budget based on the session's pricing model. Atomic decrement
  //    returns null if the buyer would overspend — return 402 with the current
  //    remaining budget (pre-this-call) so the UI can render "exhausted".
  let remainingMicroUsdc: bigint | undefined;
  let remainingMessages: number | undefined;

  if (session.pricingModel === "per-token") {
    let costMicroUsd = 0n;
    try {
      const d = JSON.parse(bodyText);
      const input  = Number(d?.prompt_eval_count) || 0;
      const output = Number(d?.eval_count) || 0;
      const rate = proxyConfig.pricePerMillionTokens ?? DEFAULT_PRICE_PER_MILLION_TOKENS;
      // micro-USDC = tokens * (rate_usd_per_million * 1_000_000_micro_usdc_per_usdc) / 1_000_000_tokens
      //            = tokens * rate
      // i.e. per-million-tokens rate in USD converts 1:1 to per-million-tokens in micro-USD.
      const microCost = Math.ceil((input + output) * rate);
      costMicroUsd = BigInt(microCost);
    } catch {
      // Non-JSON upstream — we can't meter. Fail closed: charge 0 (best for buyer)
      // and log so ops can notice. Session still counts down on expiry.
      console.warn(`[proxy] sessioned #${endpointId}: non-JSON upstream, charged 0`);
    }

    if (costMicroUsd > 0n) {
      const out = await chatSessions.decrement(payload.sid, { microUsdc: costMicroUsd });
      if (!out) {
        return c.json({
          error: "Session budget exhausted",
          remainingMicroUsdc: session.remainingMicroUsdc?.toString() ?? "0",
          expiresAt: session.expiresAt,
        }, 402);
      }
      remainingMicroUsdc = out.remainingMicroUsdc;
    } else {
      remainingMicroUsdc = session.remainingMicroUsdc ?? 0n;
    }
  } else {
    const out = await chatSessions.decrement(payload.sid, { messages: 1 });
    if (!out) {
      return c.json({
        error: "Session exhausted",
        remainingMessages: session.remainingMessages ?? 0,
        expiresAt: session.expiresAt,
      }, 402);
    }
    remainingMessages = out.remainingMessages;
  }

  // 9. Build the response headers the chat UI watches.
  const respHeaders: Record<string, string> = {
    "content-type": upstreamRes.headers.get("content-type") || "application/json",
    "x-session-expires-at": String(session.expiresAt),
  };
  if (remainingMicroUsdc !== undefined) {
    respHeaders["x-session-remaining-micro-usdc"] = remainingMicroUsdc.toString();
  }
  if (remainingMessages !== undefined) {
    respHeaders["x-session-remaining-messages"] = String(remainingMessages);
  }

  return new Response(bodyText, { status: upstreamRes.status, headers: respHeaders });
}

export default router;
