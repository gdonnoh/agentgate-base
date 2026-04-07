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

export interface ProxyConfig {
  endpointId:      number;
  name:            string;
  backendUrl:      string;
  injectHeaders:   Record<string, string>;
  publisherAddr:   string;
  requireWorldId:  boolean;
  registeredAt:    Date;
}

// ── Call tracking (in-memory — resets on restart) ────────────────────────────
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
    const calls = endpointCalls.get(endpointId) || [];
    calls.push({ agentAddress: agentAddress.toLowerCase(), timestamp: Date.now(), freeTrial, priceUsd, platformFee, publisherNet });
    endpointCalls.set(endpointId, calls);
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

// ── PostgreSQL backend ──────────────────────────────────────────────────────
let pgPool: any = null;

async function initPostgres() {
  if (!POSTGRES_URL) return false;
  try {
    const { Pool } = await import("pg");
    pgPool = new Pool({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false }, max: 5 });

    // Create table if not exists
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

    // Load all configs into cache
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
      };
      cache.set(config.endpointId, config);
    }

    console.log(`[proxyStore] PostgreSQL connected — loaded ${cache.size} configs`);
    return true;
  } catch (e: any) {
    console.warn("[proxyStore] PostgreSQL failed, falling back to file:", e.message);
    return false;
  }
}

async function pgSet(config: ProxyConfig) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO proxy_configs (endpoint_id, name, backend_url, inject_headers, publisher_addr, require_world_id, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (endpoint_id) DO UPDATE SET
       name = $2, backend_url = $3, inject_headers = $4,
       publisher_addr = $5, require_world_id = $6, registered_at = $7`,
    [config.endpointId, config.name, config.backendUrl, JSON.stringify(config.injectHeaders),
     config.publisherAddr, config.requireWorldId, config.registeredAt]
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
      const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as ProxyConfig[];
      for (const config of data) {
        config.registeredAt = new Date(config.registeredAt);
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
