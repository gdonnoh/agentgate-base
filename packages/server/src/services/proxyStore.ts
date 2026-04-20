/**
 * proxyStore.ts
 *
 * Persistent store for proxy endpoint configurations.
 *
 * Storage backends (in priority order):
 *   1. PostgreSQL (Neon) — if POSTGRES_URL env var is set
 *   2. Local JSON file  — fallback for local development
 *
 * Both backends expose the same interface. The DB backend persists
 * across deploys and server restarts — no more lost configs.
 */

import * as fs from "fs";
import * as path from "path";

export type ContentType = "webpage" | "api";

/**
 * "per-call"  = flat price per request (the on-chain registry price is used)
 * "per-token" = token-budget pricing. Publisher sets USD/1M tokens + max
 *               input/output caps. Server computes the max possible cost
 *               per call (inputTokens * rate + maxOutputTokens * rate) and
 *               charges that via the existing "exact" x402 scheme. Actual
 *               usage (parsed from the response body) is recorded alongside
 *               the charged amount in stats so publishers can see delta.
 *               This is NOT true per-token billing — buyers pay the max
 *               budget regardless of actual usage. True partial settlement
 *               needs the UptoEvmScheme and a self-hosted facilitator wallet.
 */
export type PricingModel = "per-call" | "per-token";

export interface ProxyConfig {
  endpointId:      number;
  name:            string;
  backendUrl:      string;
  injectHeaders:   Record<string, string>;
  publisherAddr:   string;
  requireWorldId:  boolean;
  registeredAt:    Date;
  /** Max concurrent in-flight proxy calls allowed; extra requests get 429 before payment. */
  maxConcurrent:   number;
  /** Seconds the x402 payment challenge is valid for — longer is needed for slow AI backends. */
  paymentTimeoutSeconds: number;
  /**
   * "webpage" = proxy returns a redirect to backendUrl after payment (no
   *             upstream forwarding, no concurrency concerns, no timeout).
   * "api"     = proxy fetches backendUrl with the caller's method/body and
   *             streams the response back; concurrency + timeout matter.
   * Drives what the dashboard surfaces to the publisher.
   */
  contentType:     ContentType;
  /** Pricing model — flat per call or token-budget. */
  pricingModel:    PricingModel;
  /** Random token for CLI tunnel auth. Generated once at publish time,
   *  shown to the publisher, then used by the CLI to update backendUrl
   *  without needing a wallet signature. Never exposed in public API. */
  tunnelToken?:    string;
  /** USD per 1,000,000 tokens (input+output pooled). Only used when pricingModel === "per-token". */
  pricePerMillionTokens?: number;
  /** Max input tokens allowed per request (approximated as body length / 4). */
  maxInputTokens?: number;
  /** Max output tokens (injected as num_predict in the upstream body). */
  maxOutputTokens?: number;
  /**
   * Optional per-endpoint override of the proxy path whitelist. When unset,
   * the proxy uses DEFAULT_ALLOWED_PATHS (inference + OpenAI-compat paths).
   * Entries ending in "/" are treated as prefix matches (e.g. "/v1/" matches
   * "/v1/chat/completions"). Path traversal (".." in suffix) is always
   * rejected regardless of this list.
   */
  allowedPaths?: string[];
  /**
   * List of model names the CLI scraped from the publisher's Ollama /api/tags.
   * Rendered as a dropdown in the browser chat UI so a buyer can pick which
   * model to talk to. Empty / missing means we show no selector.
   */
  models?: string[];
  /**
   * Last time a tunnel token was successfully used via set-tunnel. Updated
   * atomically with token rotation so replay attempts don't race. Serves as
   * a heartbeat marker too — an old stale token with no recent use gets
   * invalidated on next login.
   */
  tunnelTokenUsedAt?: number;
  /**
   * Last time the CLI pushed an auto-detected config via set-tunnel. Null /
   * undefined means the fields currently on the config were set by the
   * dashboard (publisher) rather than the CLI. The CLI push is authoritative
   * for detected fields every time it runs — this marker is mostly for UI so
   * the dashboard can show "Last auto-detected: Xm ago".
   */
  detectedAt?: number | null;
}

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 60;
export const MIN_PAYMENT_TIMEOUT_SECONDS = 10;
export const MAX_PAYMENT_TIMEOUT_SECONDS = 300;
export const MIN_MAX_CONCURRENT = 1;
export const MAX_MAX_CONCURRENT = 100;
export const DEFAULT_CONTENT_TYPE: ContentType = "api";
export const DEFAULT_PRICING_MODEL: PricingModel = "per-call";
// Sensible defaults for per-token mode. Tuned for small models on consumer
// hardware running via the public quick-tunnel — aggressive caps keep each
// call inside the ~100s cloudflared upstream timeout.
export const DEFAULT_PRICE_PER_MILLION_TOKENS = 10;   // USD per 1M tokens
export const DEFAULT_MAX_INPUT_TOKENS          = 4000;
export const DEFAULT_MAX_OUTPUT_TOKENS         = 1000;
export const MAX_ALLOWED_INPUT_TOKENS          = 32000;
export const MAX_ALLOWED_OUTPUT_TOKENS         = 8000;

// ── Call tracking (persisted to Postgres if POSTGRES_URL is set) ─────────────
//
// In-memory maps are the read path (fast, no DB roundtrip on every API call).
// Postgres is the source of truth — on startup we hydrate the maps from the
// `proxy_calls` table, so the counters survive Render restarts/sleeps.
interface CallRecord {
  agentAddress: string;
  timestamp:    number;
  freeTrial:    boolean;
  priceUsd:     number;
  platformFee:  number;
  publisherNet: number;
}

const endpointCalls = new Map<number, CallRecord[]>();
const FREE_TRIAL_LIMIT = 3;
const freeTrialUsage = new Map<string, number>();

// Hot cache for tx-hash replay protection. Backed by the `used_tx_hashes`
// Postgres table when POSTGRES_URL is set; the cache alone handles the
// file-backend / local-dev case.
//
// Map<txHash, insertedAtMs> so we can evict entries older than 7 days and
// keep the Map bounded. Postgres remains the source of truth for anything
// not currently hot in RAM.
const usedTxHashCache = new Map<string, number>();
const USED_TX_CACHE_MAX = 100_000;
const USED_TX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USED_TX_CACHE_CLEAN_INTERVAL_MS = 10 * 60 * 1000;

function pruneUsedTxHashCache() {
  const now = Date.now();
  // Drop expired entries.
  for (const [k, ts] of usedTxHashCache) {
    if (now - ts > USED_TX_CACHE_TTL_MS) usedTxHashCache.delete(k);
  }
  // Bound size: evict oldest N entries until we're under the cap. Map
  // iteration order is insertion order, so the first keys are the oldest.
  while (usedTxHashCache.size > USED_TX_CACHE_MAX) {
    const first = usedTxHashCache.keys().next().value;
    if (first === undefined) break;
    usedTxHashCache.delete(first);
  }
}

// Periodic cleanup. `unref()` so the timer doesn't keep the process alive
// during graceful shutdown / tests.
const usedTxCleanupTimer = setInterval(pruneUsedTxHashCache, USED_TX_CACHE_CLEAN_INTERVAL_MS);
if (typeof usedTxCleanupTimer.unref === "function") usedTxCleanupTimer.unref();

export const callTracker = {
  record(endpointId: number, agentAddress: string, freeTrial: boolean, priceUsd = 0, platformFeePct = 5) {
    const platformFee = freeTrial ? 0 : priceUsd * (platformFeePct / 100);
    const publisherNet = freeTrial ? 0 : priceUsd - platformFee;
    const addr = agentAddress.toLowerCase();
    const timestamp = Date.now();
    const calls = endpointCalls.get(endpointId) || [];
    calls.push({ agentAddress: addr, timestamp, freeTrial, priceUsd, platformFee, publisherNet });
    endpointCalls.set(endpointId, calls);
    // Fire-and-forget DB write. Failures are logged but don't break the proxy
    // path — the in-memory copy is enough to serve the next request.
    if (usePostgres) {
      pgRecordCall(endpointId, addr, freeTrial, priceUsd, platformFee, publisherNet, timestamp)
        .catch(e => console.warn("[callTracker] pgRecordCall error:", e.message));
    }
  },

  getStats(endpointId: number) {
    const calls = endpointCalls.get(endpointId) || [];
    const totalCalls = calls.length;
    const freeTrialCalls = calls.filter(c => c.freeTrial).length;
    const paidCalls = totalCalls - freeTrialCalls;
    const uniqueAgents = new Set(calls.map(c => c.agentAddress)).size;
    const totalRevenue = calls.reduce((s, c) => s + c.priceUsd, 0);
    const platformRevenue = calls.reduce((s, c) => s + c.platformFee, 0);
    const publisherRevenue = calls.reduce((s, c) => s + c.publisherNet, 0);
    return { totalCalls, freeTrialCalls, paidCalls, uniqueAgents, totalRevenue, platformRevenue, publisherRevenue };
  },

  getAgentStats(endpointId: number, agentAddress: string) {
    const calls = endpointCalls.get(endpointId) || [];
    const agentCalls = calls.filter(c => c.agentAddress === agentAddress.toLowerCase());
    const freeUsed = agentCalls.filter(c => c.freeTrial).length;
    return { totalCalls: agentCalls.length, freeUsed, freeRemaining: Math.max(0, FREE_TRIAL_LIMIT - freeUsed) };
  },

  checkFreeTrial(agentAddress: string, endpointId: number): { allowed: boolean; used: number } {
    const key = `${agentAddress.toLowerCase()}:${endpointId}`;
    const used = freeTrialUsage.get(key) || 0;
    return { allowed: used < FREE_TRIAL_LIMIT, used };
  },

  consumeFreeTrial(agentAddress: string, endpointId: number): void {
    const addr = agentAddress.toLowerCase();
    const key = `${addr}:${endpointId}`;
    const next = (freeTrialUsage.get(key) || 0) + 1;
    freeTrialUsage.set(key, next);
    if (usePostgres) {
      pgUpsertFreeTrial(addr, endpointId, next)
        .catch(e => console.warn("[callTracker] pgUpsertFreeTrial error:", e.message));
    }
  },

  getAllStats() {
    const result: Record<number, ReturnType<typeof callTracker.getStats>> = {};
    for (const [id] of endpointCalls) {
      result[id] = this.getStats(id);
    }
    return result;
  },
};

// ── Proxy Store (PostgreSQL or file-based) ──────────────────────────────────

const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

// In-memory cache (always used for fast reads)
const cache = new Map<number, ProxyConfig>();

// Hidden endpoint tracker — per-publisher Set of endpoint IDs the publisher
// has opted to hide from their Manage view and the public Dashboard. Lookup
// key is the lowercased wallet address.
const hiddenByPublisher = new Map<string, Set<number>>();

// ── PostgreSQL backend ──────────────────────────────────────────────────────
let pgPool: any = null;

/**
 * Strip `sslmode=...` from a Postgres URL. pg-connection-string (used by
 * node-postgres) parses `sslmode` from the URL and prints a deprecation
 * warning on every connect because the semantics of `prefer`/`require` are
 * changing in pg v9. We pass our own `ssl` object to Pool() anyway, so the
 * URL-level sslmode is redundant — removing it silences the warning.
 */
function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return url;
  }
}

async function initPostgres() {
  if (!POSTGRES_URL) return false;
  try {
    const { Pool } = await import("pg");
    pgPool = new Pool({
      connectionString: stripSslMode(POSTGRES_URL),
      ssl: { rejectUnauthorized: false },
      max: 5,
    });

    // Create tables if not exist
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS proxy_configs (
        endpoint_id     INTEGER PRIMARY KEY,
        name            TEXT NOT NULL DEFAULT '',
        backend_url     TEXT NOT NULL,
        inject_headers  JSONB NOT NULL DEFAULT '{}',
        publisher_addr  TEXT NOT NULL,
        require_world_id BOOLEAN NOT NULL DEFAULT FALSE,
        registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add new columns for existing installs — these were added after the
    // initial schema, so ALTER TABLE IF NOT EXISTS keeps old DBs compatible.
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS max_concurrent INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CONCURRENT}`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS payment_timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_PAYMENT_TIMEOUT_SECONDS}`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT '${DEFAULT_CONTENT_TYPE}'`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS tunnel_token TEXT`
    );
    // Per-token pricing fields. NULLABLE because per-call endpoints (the
    // default) don't use them at all.
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT '${DEFAULT_PRICING_MODEL}'`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS price_per_million_tokens DOUBLE PRECISION`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS max_input_tokens INTEGER`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER`
    );
    // Option A: auto-detected config pushed by the CLI. allowed_paths is a
    // JSONB array (per-endpoint proxy whitelist override); detected_at is a
    // nullable timestamp marking the last CLI push so the UI can display it.
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS allowed_paths JSONB`
    );
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ`
    );
    // List of model names the CLI pulled from /api/tags — rendered as the
    // chat UI's model dropdown. JSONB because it's a simple array blob.
    await pgPool.query(
      `ALTER TABLE proxy_configs
         ADD COLUMN IF NOT EXISTS models JSONB`
    );
    // Chat-session token ledger. One row per session issued by the paywall
    // after a browser pays. The sid is the HMAC-signed primary key embedded
    // in the session token. `remaining_*` columns are the session budget:
    //   per-token  → remaining_micro_usdc counts down as tokens burn
    //   per-call   → remaining_messages counts down by 1 per /api/chat call
    // Atomic UPDATE ... WHERE remaining_* >= $amt RETURNING prevents a buyer
    // from spending more than they paid for across concurrent requests.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        sid                     TEXT PRIMARY KEY,
        endpoint_id             BIGINT NOT NULL,
        tx_hash                 TEXT,
        pricing_model           TEXT NOT NULL,
        remaining_micro_usdc    BIGINT,
        remaining_messages      INTEGER,
        expires_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.query(
      "CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires ON chat_sessions(expires_at)"
    );
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS proxy_calls (
        id            BIGSERIAL PRIMARY KEY,
        endpoint_id   INTEGER NOT NULL,
        agent_address TEXT NOT NULL,
        free_trial    BOOLEAN NOT NULL,
        price_usd     DOUBLE PRECISION NOT NULL,
        platform_fee  DOUBLE PRECISION NOT NULL,
        publisher_net DOUBLE PRECISION NOT NULL,
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.query(
      "CREATE INDEX IF NOT EXISTS idx_proxy_calls_endpoint ON proxy_calls(endpoint_id)"
    );
    // Replay protection: remember which tx hashes we've already credited so
    // a buyer can't re-use the same on-chain transfer twice across restarts.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS used_tx_hashes (
        tx_hash TEXT PRIMARY KEY,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Persistent free-trial counters — the in-memory freeTrialUsage Map was
    // rebuilt from `proxy_calls` on boot, but once we prune old call rows or
    // migrate to per-agent accounting this table becomes the source of truth.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS free_trial_usage (
        agent_address TEXT NOT NULL,
        endpoint_id   BIGINT NOT NULL,
        count         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_address, endpoint_id)
      )
    `);
    // Hidden endpoints — a publisher flagging their own endpoint as hidden
    // removes it from their Manage list and from the public dashboard. The
    // endpoint itself stays on-chain (we can't burn it) and the proxy still
    // serves paid calls for buyers who already know the URL — this table is
    // purely a frontend listing filter.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS hidden_endpoints (
        endpoint_id    INTEGER NOT NULL,
        publisher_addr TEXT NOT NULL,
        hidden_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (endpoint_id, publisher_addr)
      )
    `);

    // Load all proxy configs into cache
    const { rows } = await pgPool.query("SELECT * FROM proxy_configs");
    for (const row of rows) {
      const config: ProxyConfig = {
        endpointId:     row.endpoint_id,
        name:           row.name,
        backendUrl:     row.backend_url,
        injectHeaders:  row.inject_headers,
        publisherAddr:  row.publisher_addr,
        requireWorldId: row.require_world_id,
        registeredAt:   new Date(row.registered_at),
        maxConcurrent:  row.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
        paymentTimeoutSeconds: row.payment_timeout_seconds ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS,
        contentType:    (row.content_type === "webpage" ? "webpage" : "api") as ContentType,
        pricingModel:   (row.pricing_model === "per-token" ? "per-token" : "per-call") as PricingModel,
        pricePerMillionTokens: row.price_per_million_tokens ?? undefined,
        maxInputTokens:  row.max_input_tokens ?? undefined,
        maxOutputTokens: row.max_output_tokens ?? undefined,
        tunnelToken:     row.tunnel_token ?? undefined,
        allowedPaths:    Array.isArray(row.allowed_paths) ? row.allowed_paths : undefined,
        models:          Array.isArray(row.models) ? row.models : undefined,
        detectedAt:      row.detected_at ? new Date(row.detected_at).getTime() : null,
      };
      cache.set(config.endpointId, config);
    }

    // Hydrate call tracker from proxy_calls. Iterating in chronological order
    // means freeTrialUsage gets rebuilt with the correct counts.
    const { rows: callRows } = await pgPool.query(
      "SELECT * FROM proxy_calls ORDER BY recorded_at ASC"
    );
    for (const row of callRows) {
      const epId = row.endpoint_id;
      const addr = String(row.agent_address).toLowerCase();
      const list = endpointCalls.get(epId) || [];
      list.push({
        agentAddress: addr,
        timestamp:    new Date(row.recorded_at).getTime(),
        freeTrial:    row.free_trial,
        priceUsd:     Number(row.price_usd),
        platformFee:  Number(row.platform_fee),
        publisherNet: Number(row.publisher_net),
      });
      endpointCalls.set(epId, list);
      if (row.free_trial) {
        const key = `${addr}:${epId}`;
        freeTrialUsage.set(key, (freeTrialUsage.get(key) || 0) + 1);
      }
    }

    // Hydrate hidden endpoints from DB — one key per (publisherAddr) → Set<id>
    const { rows: hiddenRows } = await pgPool.query("SELECT * FROM hidden_endpoints");
    for (const row of hiddenRows) {
      const addr = String(row.publisher_addr).toLowerCase();
      const set = hiddenByPublisher.get(addr) || new Set<number>();
      set.add(Number(row.endpoint_id));
      hiddenByPublisher.set(addr, set);
    }

    // Hydrate the hot cache of used tx hashes so /api/proxy can reject replays
    // without a DB round-trip on every call. We cap the hydration at
    // USED_TX_CACHE_MAX rows so startup stays O(1) in memory; older entries
    // still live in Postgres and the async fallback path picks them up.
    const { rows: txRows } = await pgPool.query(
      "SELECT tx_hash, used_at FROM used_tx_hashes ORDER BY used_at DESC LIMIT $1",
      [USED_TX_CACHE_MAX]
    );
    for (const row of txRows) {
      usedTxHashCache.set(String(row.tx_hash).toLowerCase(), new Date(row.used_at).getTime());
    }

    // Hydrate the free-trial counter map. Prefer the dedicated table (source
    // of truth) and fall back to the call-log count we built above if a row
    // is missing — during the first deploy after this migration the new table
    // is empty.
    const { rows: ftRows } = await pgPool.query(
      "SELECT agent_address, endpoint_id, count FROM free_trial_usage"
    );
    for (const row of ftRows) {
      const key = `${String(row.agent_address).toLowerCase()}:${row.endpoint_id}`;
      freeTrialUsage.set(key, Number(row.count));
    }

    console.log(
      `[proxyStore] PostgreSQL connected — loaded ${cache.size} configs, ${callRows.length} call records, ${hiddenRows.length} hidden entries`
    );
    return true;
  } catch (e: any) {
    console.warn("[proxyStore] PostgreSQL failed, falling back to file:", e.message);
    return false;
  }
}

async function pgRecordCall(
  endpointId: number,
  agentAddress: string,
  freeTrial: boolean,
  priceUsd: number,
  platformFee: number,
  publisherNet: number,
  timestampMs: number,
) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO proxy_calls
       (endpoint_id, agent_address, free_trial, price_usd, platform_fee, publisher_net, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
    [endpointId, agentAddress, freeTrial, priceUsd, platformFee, publisherNet, timestampMs]
  );
}

async function pgSet(config: ProxyConfig) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO proxy_configs
       (endpoint_id, name, backend_url, inject_headers, publisher_addr,
        require_world_id, registered_at, max_concurrent, payment_timeout_seconds,
        content_type, pricing_model, price_per_million_tokens,
        max_input_tokens, max_output_tokens, tunnel_token,
        allowed_paths, detected_at, models)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (endpoint_id) DO UPDATE SET
       name = $2, backend_url = $3, inject_headers = $4,
       publisher_addr = $5, require_world_id = $6, registered_at = $7,
       max_concurrent = $8, payment_timeout_seconds = $9,
       content_type = $10, pricing_model = $11, price_per_million_tokens = $12,
       max_input_tokens = $13, max_output_tokens = $14,
       tunnel_token = COALESCE($15, proxy_configs.tunnel_token),
       allowed_paths = $16, detected_at = $17, models = $18`,
    [config.endpointId, config.name, config.backendUrl, JSON.stringify(config.injectHeaders),
     config.publisherAddr, config.requireWorldId, config.registeredAt,
     config.maxConcurrent, config.paymentTimeoutSeconds, config.contentType,
     config.pricingModel, config.pricePerMillionTokens ?? null,
     config.maxInputTokens ?? null, config.maxOutputTokens ?? null,
     config.tunnelToken ?? null,
     config.allowedPaths ? JSON.stringify(config.allowedPaths) : null,
     config.detectedAt ? new Date(config.detectedAt) : null,
     config.models ? JSON.stringify(config.models) : null]
  );
}

async function pgDelete(endpointId: number) {
  if (!pgPool) return;
  await pgPool.query("DELETE FROM proxy_configs WHERE endpoint_id = $1", [endpointId]);
}

async function pgMarkTxHashUsed(txHash: string) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO used_tx_hashes (tx_hash) VALUES ($1)
       ON CONFLICT (tx_hash) DO NOTHING`,
    [txHash]
  );
}

async function pgIsTxHashUsed(txHash: string): Promise<boolean> {
  if (!pgPool) return false;
  const { rows } = await pgPool.query(
    "SELECT 1 FROM used_tx_hashes WHERE tx_hash = $1 LIMIT 1",
    [txHash]
  );
  return rows.length > 0;
}

async function pgUpsertFreeTrial(agentAddress: string, endpointId: number, count: number) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO free_trial_usage (agent_address, endpoint_id, count) VALUES ($1, $2, $3)
       ON CONFLICT (agent_address, endpoint_id) DO UPDATE SET count = EXCLUDED.count`,
    [agentAddress, endpointId, count]
  );
}

// ── File backend (local dev fallback) ───────────────────────────────────────
const DATA_DIR = process.env.VERCEL ? "/tmp" : path.resolve(__dirname, "../../data");
const STORE_FILE = path.join(DATA_DIR, "proxy-configs.json");

function loadFromFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as Partial<ProxyConfig>[];
      for (const raw of data) {
        const config: ProxyConfig = {
          endpointId:     raw.endpointId!,
          name:           raw.name ?? "",
          backendUrl:     raw.backendUrl!,
          injectHeaders:  raw.injectHeaders ?? {},
          publisherAddr:  raw.publisherAddr!,
          requireWorldId: raw.requireWorldId ?? false,
          registeredAt:   new Date(raw.registeredAt!),
          // Back-fill defaults for configs saved before these fields existed.
          maxConcurrent:  raw.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
          paymentTimeoutSeconds: raw.paymentTimeoutSeconds ?? DEFAULT_PAYMENT_TIMEOUT_SECONDS,
          contentType:    (raw.contentType === "webpage" ? "webpage" : DEFAULT_CONTENT_TYPE),
          pricingModel:   (raw.pricingModel === "per-token" ? "per-token" : DEFAULT_PRICING_MODEL),
          pricePerMillionTokens: raw.pricePerMillionTokens,
          maxInputTokens:  raw.maxInputTokens,
          maxOutputTokens: raw.maxOutputTokens,
          tunnelToken:     raw.tunnelToken,
          allowedPaths:    Array.isArray(raw.allowedPaths) ? raw.allowedPaths : undefined,
          models:          Array.isArray(raw.models) ? raw.models : undefined,
          detectedAt:      raw.detectedAt ?? null,
        };
        cache.set(config.endpointId, config);
      }
      console.log(`[proxyStore] File loaded — ${cache.size} configs`);
    }
  } catch (e: any) {
    console.warn("[proxyStore] Could not load file:", e.message);
  }
}

function saveToFile() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Array.from(cache.values()), null, 2));
  } catch {}
}

// ── Initialize ──────────────────────────────────────────────────────────────
let usePostgres = false;

// Async init — called at import time
(async () => {
  usePostgres = await initPostgres();
  if (!usePostgres) loadFromFile();
})();

// ── Public API ──────────────────────────────────────────────────────────────
export const proxyStore = {
  set(config: ProxyConfig) {
    cache.set(config.endpointId, config);
    if (usePostgres) {
      pgSet(config).catch(e => console.warn("[proxyStore] pgSet error:", e.message));
    } else {
      saveToFile();
    }
  },

  get(endpointId: number): ProxyConfig | undefined {
    return cache.get(endpointId);
  },

  delete(endpointId: number) {
    cache.delete(endpointId);
    if (usePostgres) {
      pgDelete(endpointId).catch(e => console.warn("[proxyStore] pgDelete error:", e.message));
    } else {
      saveToFile();
    }
  },

  all(): ProxyConfig[] {
    return Array.from(cache.values());
  },

  /**
   * One-shot cleanup of proxy configs left behind by a Registry redeploy.
   * Any config whose endpointId >= `onChainCount` points at an ID the current
   * Registry will never hand out, so it's a dead row: delete it from the
   * in-memory cache and from Postgres. Returns the number of rows deleted.
   *
   * Intended to be called once at server startup after the cache has hydrated.
   */
  async purgeOrphansAboveCount(onChainCount: number): Promise<number> {
    const toDelete: number[] = [];
    for (const id of cache.keys()) {
      if (id >= onChainCount) toDelete.push(id);
    }
    for (const id of toDelete) cache.delete(id);
    if (usePostgres && pgPool) {
      await pgPool.query(
        "DELETE FROM proxy_configs WHERE endpoint_id >= $1",
        [onChainCount],
      );
    } else if (toDelete.length > 0) {
      saveToFile();
    }
    return toDelete.length;
  },

  /** Find a config by its tunnel token. Returns undefined if not found or
   *  if the endpoint has no token assigned. O(N) scan — fine at small scale. */
  getByTunnelToken(token: string): ProxyConfig | undefined {
    if (!token) return undefined;
    for (const config of cache.values()) {
      if (config.tunnelToken && config.tunnelToken === token) return config;
    }
    return undefined;
  },

  /**
   * True if we've already credited this browser tx hash to an endpoint call.
   * Hot path hits the in-memory Set; when that misses we fall through to
   * Postgres so a server restart never re-opens an already-spent tx.
   */
  async isTxHashUsed(txHash: string): Promise<boolean> {
    const h = txHash.toLowerCase();
    if (usedTxHashCache.has(h)) return true;
    if (!usePostgres) return false;
    try {
      const used = await pgIsTxHashUsed(h);
      if (used) usedTxHashCache.set(h, Date.now());
      return used;
    } catch (e: any) {
      console.warn("[proxyStore] pgIsTxHashUsed error:", e.message);
      return false;
    }
  },

  /** Mark a browser tx hash as spent. In-memory first, then best-effort DB write. */
  async markTxHashUsed(txHash: string): Promise<void> {
    const h = txHash.toLowerCase();
    usedTxHashCache.set(h, Date.now());
    if (usePostgres) {
      try {
        await pgMarkTxHashUsed(h);
      } catch (e: any) {
        console.warn("[proxyStore] pgMarkTxHashUsed error:", e.message);
      }
    }
  },
};

// ── Hidden endpoints API ────────────────────────────────────────────────────
async function pgHide(endpointId: number, publisherAddr: string) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO hidden_endpoints (endpoint_id, publisher_addr)
     VALUES ($1, $2)
     ON CONFLICT (endpoint_id, publisher_addr) DO NOTHING`,
    [endpointId, publisherAddr]
  );
}

async function pgUnhide(endpointId: number, publisherAddr: string) {
  if (!pgPool) return;
  await pgPool.query(
    `DELETE FROM hidden_endpoints WHERE endpoint_id = $1 AND publisher_addr = $2`,
    [endpointId, publisherAddr]
  );
}

export const hiddenEndpoints = {
  /** Is this endpoint currently hidden by the given publisher? */
  isHidden(endpointId: number, publisherAddr: string): boolean {
    const addr = publisherAddr.toLowerCase();
    return hiddenByPublisher.get(addr)?.has(endpointId) ?? false;
  },

  /** List of hidden endpoint IDs for a given publisher. */
  getHiddenIds(publisherAddr: string): number[] {
    const addr = publisherAddr.toLowerCase();
    return Array.from(hiddenByPublisher.get(addr) || []);
  },

  /** Is this endpoint hidden by ANY publisher? Used by the public /overview
   *  to drop hidden-by-owner rows from the global listing. */
  isHiddenAnywhere(endpointId: number): boolean {
    for (const set of hiddenByPublisher.values()) {
      if (set.has(endpointId)) return true;
    }
    return false;
  },

  hide(endpointId: number, publisherAddr: string) {
    const addr = publisherAddr.toLowerCase();
    const set = hiddenByPublisher.get(addr) || new Set<number>();
    set.add(endpointId);
    hiddenByPublisher.set(addr, set);
    if (usePostgres) {
      pgHide(endpointId, addr).catch(e => console.warn("[hidden] pgHide error:", e.message));
    }
  },

  unhide(endpointId: number, publisherAddr: string) {
    const addr = publisherAddr.toLowerCase();
    const set = hiddenByPublisher.get(addr);
    if (set) {
      set.delete(endpointId);
      if (set.size === 0) hiddenByPublisher.delete(addr);
    }
    if (usePostgres) {
      pgUnhide(endpointId, addr).catch(e => console.warn("[hidden] pgUnhide error:", e.message));
    }
  },
};

// ── Chat session ledger ──────────────────────────────────────────────────────
//
// A chat session is the short-lived bearer-token identity the browser paywall
// uses after a successful USDC payment. The token itself is HMAC-signed (see
// proxy.ts) and carries the `sid` — this ledger is what actually tracks how
// much budget is left. Atomic decrements guard against concurrent spend.
//
// When POSTGRES_URL is not set we fall back to an in-memory Map so local dev
// still works. Sessions expire after 15 minutes regardless of budget.

export interface ChatSession {
  sid:                    string;
  endpointId:             number;
  txHash:                 string | null;
  pricingModel:           PricingModel;
  remainingMicroUsdc:     bigint | null;
  remainingMessages:      number | null;
  expiresAt:              number;
  createdAt:              number;
}

export type ChatSessionBudget =
  | { microUsdc: bigint }
  | { messages: number };

const CHAT_SESSION_TTL_MS = 15 * 60 * 1000;

// In-memory session store for the non-Postgres path (and as a hot cache).
const memSessions = new Map<string, ChatSession>();

function pruneExpiredMemSessions() {
  const now = Date.now();
  for (const [sid, s] of memSessions) {
    if (s.expiresAt <= now) memSessions.delete(sid);
  }
}
const chatSessionCleanupTimer = setInterval(pruneExpiredMemSessions, 60_000);
if (typeof chatSessionCleanupTimer.unref === "function") chatSessionCleanupTimer.unref();

export const chatSessions = {
  async create(
    sid: string,
    endpointId: number,
    txHash: string | null,
    pricingModel: PricingModel,
    budget: ChatSessionBudget,
  ): Promise<ChatSession> {
    const now = Date.now();
    const expiresAt = now + CHAT_SESSION_TTL_MS;
    const session: ChatSession = {
      sid,
      endpointId,
      txHash,
      pricingModel,
      remainingMicroUsdc: "microUsdc" in budget ? budget.microUsdc : null,
      remainingMessages:  "messages"  in budget ? budget.messages  : null,
      expiresAt,
      createdAt: now,
    };
    memSessions.set(sid, session);
    if (usePostgres && pgPool) {
      try {
        await pgPool.query(
          `INSERT INTO chat_sessions
             (sid, endpoint_id, tx_hash, pricing_model,
              remaining_micro_usdc, remaining_messages,
              expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), to_timestamp($8/1000.0))
           ON CONFLICT (sid) DO NOTHING`,
          [
            sid, endpointId, txHash, pricingModel,
            session.remainingMicroUsdc !== null ? session.remainingMicroUsdc.toString() : null,
            session.remainingMessages,
            expiresAt, now,
          ]
        );
      } catch (e: any) {
        console.warn("[chatSessions] pg create error:", e.message);
      }
    }
    return session;
  },

  /**
   * Look up a session. Returns null if missing or expired. Always checks
   * Postgres when available — the in-memory map is only a hot cache and
   * may be empty after a server restart while sessions are still active.
   */
  async get(sid: string): Promise<ChatSession | null> {
    const now = Date.now();
    const cached = memSessions.get(sid);
    if (cached) {
      if (cached.expiresAt <= now) {
        memSessions.delete(sid);
        return null;
      }
      return cached;
    }
    if (!usePostgres || !pgPool) return null;
    try {
      const { rows } = await pgPool.query(
        `SELECT sid, endpoint_id, tx_hash, pricing_model,
                remaining_micro_usdc, remaining_messages,
                expires_at, created_at
           FROM chat_sessions WHERE sid = $1 LIMIT 1`,
        [sid]
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      const expiresAtMs = new Date(row.expires_at).getTime();
      if (expiresAtMs <= now) return null;
      const session: ChatSession = {
        sid: row.sid,
        endpointId: Number(row.endpoint_id),
        txHash: row.tx_hash ?? null,
        pricingModel: row.pricing_model === "per-token" ? "per-token" : "per-call",
        remainingMicroUsdc: row.remaining_micro_usdc !== null && row.remaining_micro_usdc !== undefined
          ? BigInt(row.remaining_micro_usdc)
          : null,
        remainingMessages: row.remaining_messages !== null && row.remaining_messages !== undefined
          ? Number(row.remaining_messages)
          : null,
        expiresAt: expiresAtMs,
        createdAt: new Date(row.created_at).getTime(),
      };
      memSessions.set(sid, session);
      return session;
    } catch (e: any) {
      console.warn("[chatSessions] pg get error:", e.message);
      return null;
    }
  },

  /**
   * Atomically decrement the session budget. Returns the new remaining balance
   * on success, or null when there isn't enough budget left (caller should
   * return 402). Postgres `UPDATE ... WHERE remaining_* >= $amt RETURNING`
   * prevents concurrent over-spend.
   */
  async decrement(
    sid: string,
    amount: { microUsdc?: bigint; messages?: number },
  ): Promise<{ remainingMicroUsdc?: bigint; remainingMessages?: number } | null> {
    // Postgres path — atomic guarded UPDATE.
    if (usePostgres && pgPool) {
      try {
        if (amount.microUsdc !== undefined) {
          const amt = amount.microUsdc;
          const { rows } = await pgPool.query(
            `UPDATE chat_sessions
               SET remaining_micro_usdc = remaining_micro_usdc - $2::bigint
             WHERE sid = $1
               AND remaining_micro_usdc IS NOT NULL
               AND remaining_micro_usdc >= $2::bigint
               AND expires_at > NOW()
             RETURNING remaining_micro_usdc, expires_at`,
            [sid, amt.toString()]
          );
          if (rows.length === 0) return null;
          const remaining = BigInt(rows[0].remaining_micro_usdc);
          const cached = memSessions.get(sid);
          if (cached) { cached.remainingMicroUsdc = remaining; memSessions.set(sid, cached); }
          return { remainingMicroUsdc: remaining };
        }
        if (amount.messages !== undefined) {
          const amt = amount.messages;
          const { rows } = await pgPool.query(
            `UPDATE chat_sessions
               SET remaining_messages = remaining_messages - $2
             WHERE sid = $1
               AND remaining_messages IS NOT NULL
               AND remaining_messages >= $2
               AND expires_at > NOW()
             RETURNING remaining_messages, expires_at`,
            [sid, amt]
          );
          if (rows.length === 0) return null;
          const remaining = Number(rows[0].remaining_messages);
          const cached = memSessions.get(sid);
          if (cached) { cached.remainingMessages = remaining; memSessions.set(sid, cached); }
          return { remainingMessages: remaining };
        }
        return null;
      } catch (e: any) {
        console.warn("[chatSessions] pg decrement error:", e.message);
        return null;
      }
    }

    // In-memory fallback path — single-process, no real concurrency concerns.
    const s = memSessions.get(sid);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { memSessions.delete(sid); return null; }
    if (amount.microUsdc !== undefined) {
      if (s.remainingMicroUsdc === null || s.remainingMicroUsdc < amount.microUsdc) return null;
      s.remainingMicroUsdc = s.remainingMicroUsdc - amount.microUsdc;
      return { remainingMicroUsdc: s.remainingMicroUsdc };
    }
    if (amount.messages !== undefined) {
      if (s.remainingMessages === null || s.remainingMessages < amount.messages) return null;
      s.remainingMessages = s.remainingMessages - amount.messages;
      return { remainingMessages: s.remainingMessages };
    }
    return null;
  },
};

export const CHAT_SESSION_TTL_SECONDS = CHAT_SESSION_TTL_MS / 1000;
