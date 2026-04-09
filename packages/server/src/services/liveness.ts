/**
 * liveness.ts
 *
 * Periodic health probes for registered proxy endpoints. Every LIVENESS_INTERVAL_MS
 * we fetch the backend URL with a HEAD request and record the result in a per-
 * endpoint ring buffer. Publishers see a up/down indicator in the dashboard; the
 * proxy route can also use the latest reading to reject paid calls fast when
 * the backend is known-dead (without making the buyer wait for a pre-flight).
 *
 * Storage is intentionally in-memory. Liveness history is cheap to rebuild
 * after a server restart — one interval tick and we're back.
 */

import { proxyStore } from "./proxyStore";

export interface LivenessCheck {
  checkedAt:  number;       // Date.now()
  statusCode: number | null;
  latencyMs:  number;
  ok:         boolean;
  error?:     string;
}

export interface LivenessSummary {
  endpointId:      number;
  currentStatus:   "up" | "down" | "unknown";
  lastCheckAt:     number | null;
  lastStatusCode:  number | null;
  lastLatencyMs:   number | null;
  lastError:       string | null;
  totalChecks:     number;
  okChecks:        number;
  uptimePercent:   number;  // over the entire ring buffer history
  avgLatencyMs:    number;  // only across successful checks
  recentChecks:    LivenessCheck[]; // last 20, newest first
}

const RING_SIZE = 100;
const LIVENESS_INTERVAL_MS = parseInt(process.env.LIVENESS_INTERVAL_MS || "900000", 10); // default 15 min
const CHECK_TIMEOUT_MS = 8000;

const history = new Map<number, LivenessCheck[]>();

function pushCheck(endpointId: number, check: LivenessCheck) {
  const arr = history.get(endpointId) || [];
  arr.push(check);
  if (arr.length > RING_SIZE) arr.splice(0, arr.length - RING_SIZE);
  history.set(endpointId, arr);
}

async function probeEndpoint(endpointId: number, backendUrl: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(backendUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    // 4xx is considered UP — auth/not-allowed means the server is responsive.
    // 5xx is DOWN. Network errors are DOWN.
    const ok = res.status < 500;
    pushCheck(endpointId, {
      checkedAt: Date.now(),
      statusCode: res.status,
      latencyMs,
      ok,
    });
    const emoji = ok ? "🟢" : "🔴";
    console.log(`[liveness] ${emoji} #${endpointId} HEAD ${res.status} ${latencyMs}ms`);
  } catch (err: any) {
    const latencyMs = Date.now() - t0;
    pushCheck(endpointId, {
      checkedAt: Date.now(),
      statusCode: null,
      latencyMs,
      ok: false,
      error: err?.message || String(err),
    });
    console.log(`[liveness] 🔴 #${endpointId} ERR ${err?.message || "unknown"} (${latencyMs}ms)`);
  }
}

async function runAllChecks(): Promise<void> {
  const configs = proxyStore.all();
  if (configs.length === 0) return;
  // Run in parallel — these are network-bound, not CPU-bound, and we want
  // the total tick to complete quickly even with many endpoints.
  await Promise.allSettled(
    configs.map(c => probeEndpoint(c.endpointId, c.backendUrl))
  );
}

let intervalHandle: NodeJS.Timeout | null = null;

/** Start the periodic liveness checker. Called once from the server bootstrap. */
export function startLivenessChecker(): void {
  if (intervalHandle) return;
  // Kick off a first check immediately so fresh dashboards have data. Small
  // delay to let proxyStore finish loading on server boot.
  setTimeout(() => { runAllChecks().catch(() => {}); }, 2000);
  intervalHandle = setInterval(() => {
    runAllChecks().catch(() => {});
  }, LIVENESS_INTERVAL_MS);
  console.log(`[liveness] checker started — interval ${Math.round(LIVENESS_INTERVAL_MS / 1000)}s`);
}

/** Stop the checker. Useful for tests. */
export function stopLivenessChecker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

/** Return a summary for one endpoint based on its ring buffer. */
export function getLivenessSummary(endpointId: number): LivenessSummary {
  const arr = history.get(endpointId) || [];
  if (arr.length === 0) {
    return {
      endpointId,
      currentStatus: "unknown",
      lastCheckAt: null,
      lastStatusCode: null,
      lastLatencyMs: null,
      lastError: null,
      totalChecks: 0,
      okChecks: 0,
      uptimePercent: 0,
      avgLatencyMs: 0,
      recentChecks: [],
    };
  }
  const last = arr[arr.length - 1];
  const okCount = arr.filter(c => c.ok).length;
  const okLatencies = arr.filter(c => c.ok).map(c => c.latencyMs);
  const avgLatency = okLatencies.length > 0
    ? Math.round(okLatencies.reduce((s, v) => s + v, 0) / okLatencies.length)
    : 0;
  return {
    endpointId,
    currentStatus: last.ok ? "up" : "down",
    lastCheckAt: last.checkedAt,
    lastStatusCode: last.statusCode,
    lastLatencyMs: last.latencyMs,
    lastError: last.error || null,
    totalChecks: arr.length,
    okChecks: okCount,
    uptimePercent: Math.round((okCount / arr.length) * 10000) / 100,
    avgLatencyMs: avgLatency,
    // Newest first so the dashboard can just render [0..19]
    recentChecks: arr.slice().reverse().slice(0, 20),
  };
}

/**
 * Force a liveness check for a single endpoint on-demand. Used by the publisher
 * route to let the user trigger a check from the dashboard without waiting
 * for the next tick.
 */
export async function probeEndpointNow(endpointId: number): Promise<LivenessSummary> {
  const config = proxyStore.get(endpointId);
  if (!config) {
    return getLivenessSummary(endpointId);
  }
  await probeEndpoint(endpointId, config.backendUrl);
  return getLivenessSummary(endpointId);
}
