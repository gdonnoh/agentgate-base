/**
 * proxyStore.ts
 *
 * Persistent store for proxy endpoint configurations.
 * Saves to a JSON file on every write — survives server restarts and redeploys.
 *
 * Security: only the endpoint's on-chain publisher can register a config,
 * verified via EIP-191 wallet signature before storing.
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

// Use /tmp on Vercel (read-only filesystem), project dir otherwise
const DATA_DIR = process.env.VERCEL ? "/tmp" : path.resolve(__dirname, "../../data");
const STORE_FILE = path.join(DATA_DIR, "proxy-configs.json");

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Load from disk on startup
const store = new Map<number, ProxyConfig>();
try {
  if (fs.existsSync(STORE_FILE)) {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as ProxyConfig[];
    for (const config of data) {
      config.registeredAt = new Date(config.registeredAt);
      store.set(config.endpointId, config);
    }
    console.log(`[proxyStore] Loaded ${store.size} configs from disk`);
  }
} catch (e: any) {
  console.warn("[proxyStore] Could not load from disk:", e.message);
}

function saveToDisk() {
  try {
    const data = Array.from(store.values());
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.warn("[proxyStore] Could not save to disk:", e.message);
  }
}

// ── Call tracking (in-memory — resets on restart, that's OK) ────────────────
interface CallRecord {
  agentAddress: string;
  timestamp:    number;
  freeTrial:    boolean;
  priceUsd:     number;    // total price charged to agent
  platformFee:  number;    // AgentGate's cut (USD)
  publisherNet: number;    // publisher's net revenue (USD)
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

export const proxyStore = {
  set(config: ProxyConfig) {
    store.set(config.endpointId, config);
    saveToDisk();
  },

  get(endpointId: number): ProxyConfig | undefined {
    return store.get(endpointId);
  },

  delete(endpointId: number) {
    store.delete(endpointId);
    saveToDisk();
  },

  all(): ProxyConfig[] {
    return Array.from(store.values());
  },
};
