/**
 * rateLimit.ts
 *
 * Tiny in-memory rate limiter with a sliding 60-second window. 60 requests
 * per minute per client-IP for the endpoints it's mounted on.
 *
 * Not durable across restarts (which is fine — an attacker winning a restart
 * race can temporarily get ~double the budget, but no payment can be skipped
 * because the paywall/settle logic still runs).
 *
 * Keys are scoped per limiter instance so /api/data/* and /api/proxy/:id keep
 * independent quotas.
 */

import type { MiddlewareHandler } from "hono";

interface Bucket {
  /** Request timestamps (ms) for the current window. Kept sorted ascending. */
  hits: number[];
}

export interface RateLimitOptions {
  /** Requests allowed per window per IP. Default: 60. */
  limit?: number;
  /** Window length in ms. Default: 60000 (1 minute). */
  windowMs?: number;
  /** Human label used in the 429 error body / logs (e.g. "data" or "proxy"). */
  name?: string;
}

// ── Per-agent limiter (R2-G) ─────────────────────────────────────────────────
// A second layer keyed by (endpointId, agentAddress). Prevents a single
// WorldID-verified agent (with 3 free-trial calls) or a wallet-authenticated
// caller from hammering a single endpoint regardless of IP rotation. Falls
// back to IP-keying when no agent address is discoverable from the request.
//
// Tight default: 20 requests / minute / agent / endpoint. Intentionally lower
// than the IP-level budget so an adversary that rotates IPs is still bounded.
export interface AgentRateLimitOptions {
  limit?: number;
  windowMs?: number;
  name?: string;
}

export function agentRateLimit(opts: AgentRateLimitOptions = {}): MiddlewareHandler {
  const LIMIT = opts.limit ?? 20;
  const WINDOW = opts.windowMs ?? 60_000;
  const NAME = opts.name ?? "agent";

  const buckets = new Map<string, Bucket>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (!b.hits.length || now - b.hits[b.hits.length - 1] > WINDOW * 5) {
        buckets.delete(k);
      }
    }
  }, 5 * 60_000);
  if (typeof cleanup.unref === "function") cleanup.unref();

  return async (c, next) => {
    // Pull endpoint id from the :endpointId param when available.
    const epId = c.req.param("endpointId") ?? "?";

    // Prefer x402 payer address, then agentkit header wallet, then IP.
    let agent: string | null = null;
    const pay = c.req.header("PAYMENT-SIGNATURE") || c.req.header("payment-signature");
    if (pay) {
      try {
        const decoded = JSON.parse(Buffer.from(pay, "base64").toString("utf-8"));
        const auth = decoded?.payload?.authorization ?? decoded?.authorization ?? null;
        const from = auth?.from ?? auth?.owner ?? auth?.signer ?? decoded?.payload?.from ?? decoded?.from;
        if (typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from)) agent = from.toLowerCase();
      } catch { /* best-effort */ }
    }
    if (!agent) {
      const ak = c.req.header("agentkit") ?? c.req.header("AGENTKIT");
      if (ak) {
        // AgentKit headers embed a signature over a payload; we don't verify
        // here (that happens later in the proxy). For rate-limit keying we
        // just hash the raw header so each distinct header hits its own bucket.
        try {
          const m = ak.match(/0x[0-9a-fA-F]{40}/);
          if (m) agent = m[0].toLowerCase();
        } catch { /* ignore */ }
      }
    }
    if (!agent) {
      const xff = c.req.header("x-forwarded-for");
      agent = (xff && xff.split(",")[0].trim()) ||
        c.req.header("x-real-ip") ||
        c.req.header("cf-connecting-ip") ||
        "unknown";
    }

    const key = `${epId}:${agent}`;
    const now = Date.now();
    const b = buckets.get(key) || { hits: [] };
    while (b.hits.length && now - b.hits[0] > WINDOW) b.hits.shift();
    if (b.hits.length >= LIMIT) {
      const retryMs = WINDOW - (now - b.hits[0]);
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      c.header("Retry-After", String(retrySec));
      c.header("X-RateLimit-Limit", String(LIMIT));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil((now + retryMs) / 1000)));
      return c.json(
        {
          error: `Too many requests (${NAME}). Per-agent limit is ${LIMIT} per ${Math.round(WINDOW / 1000)}s for this endpoint.`,
          retryAfterSeconds: retrySec,
        },
        429
      );
    }
    b.hits.push(now);
    buckets.set(key, b);
    await next();
  };
}

export function rateLimit(opts: RateLimitOptions = {}): MiddlewareHandler {
  const LIMIT = opts.limit ?? 60;
  const WINDOW = opts.windowMs ?? 60_000;
  const NAME = opts.name ?? "route";

  const buckets = new Map<string, Bucket>();

  // Occasional cleanup so idle IPs don't leak memory forever. Fire every 5
  // minutes; cheap because we iterate a Map whose size is bounded by the
  // number of distinct IPs hitting us.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (!b.hits.length || now - b.hits[b.hits.length - 1] > WINDOW * 5) {
        buckets.delete(k);
      }
    }
  }, 5 * 60_000);
  if (typeof cleanup.unref === "function") cleanup.unref();

  return async (c, next) => {
    // Best-effort IP extraction. Hono's Node adapter gives us the raw headers.
    const xff = c.req.header("x-forwarded-for");
    const ip =
      (xff && xff.split(",")[0].trim()) ||
      c.req.header("x-real-ip") ||
      c.req.header("cf-connecting-ip") ||
      "unknown";

    const now = Date.now();
    const b = buckets.get(ip) || { hits: [] };
    // Drop hits older than the window.
    while (b.hits.length && now - b.hits[0] > WINDOW) b.hits.shift();
    if (b.hits.length >= LIMIT) {
      const retryMs = WINDOW - (now - b.hits[0]);
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      c.header("Retry-After", String(retrySec));
      c.header("X-RateLimit-Limit", String(LIMIT));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil((now + retryMs) / 1000)));
      return c.json(
        {
          error: `Too many requests (${NAME}). Limit is ${LIMIT} per ${Math.round(WINDOW / 1000)}s.`,
          retryAfterSeconds: retrySec,
        },
        429
      );
    }
    b.hits.push(now);
    buckets.set(ip, b);

    c.header("X-RateLimit-Limit", String(LIMIT));
    c.header("X-RateLimit-Remaining", String(LIMIT - b.hits.length));

    await next();
  };
}
