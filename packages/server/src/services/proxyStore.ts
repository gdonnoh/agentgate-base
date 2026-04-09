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
}

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 60;
export const MIN_PAYMENT_TIMEOUT_SECONDS = 10;
export const MAX_PAYMENT_TIMEOUT_SECONDS = 300;
export const MIN_MAX_CONCURRENT = 1;
export const MAX_MAX_CONCURRENT = 100;
export const DEFAULT_CONTENT_TYPE: ContentType = "api";

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
    const key = `${agentAddress.toLowerCase()}:${endpointId}`;
    freeTrialUsage.set(key, (freeTrialUsage.get(key) || 0) + 1);
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
        content_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (endpoint_id) DO UPDATE SET
       name = $2, backend_url = $3, inject_headers = $4,
       publisher_addr = $5, require_world_id = $6, registered_at = $7,
       max_concurrent = $8, payment_timeout_seconds = $9,
       content_type = $10`,
    [config.endpointId, config.name, config.backendUrl, JSON.stringify(config.injectHeaders),
     config.publisherAddr, config.requireWorldId, config.registeredAt,
     config.maxConcurrent, config.paymentTimeoutSeconds, config.contentType]
  );
}

async function pgDelete(endpointId: number) {
  if (!pgPool) return;
  await pgPool.query("DELETE FROM proxy_configs WHERE endpoint_id = $1", [endpointId]);
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
