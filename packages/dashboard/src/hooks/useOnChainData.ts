import { useEffect, useState, useCallback } from "react";

export interface OnChainData {
  deployerBalance: string;
  paymasterDeposit: string;
  dailyBudget: string;
  dailySpent: string;
  remainingBudget: string;
  totalCalls: number;
  totalSponsored: string;
  lastReset: Date | null;
  totalEndpoints: number;
  endpoints: EndpointData[];
  lastUpdated: Date | null;
  loading: boolean;
  error: string | null;
}

export interface EndpointProxyStats {
  totalCalls: number;
  freeTrialCalls: number;
  paidCalls: number;
  uniqueAgents: number;
  totalRevenue: number;
  publisherRevenue: number;
}

export interface EndpointLiveness {
  currentStatus: "up" | "down" | "unknown";
  lastCheckAt: number | null;
  lastLatencyMs: number | null;
  uptimePercent: number;
  avgLatencyMs: number;
  totalChecks: number;
  okChecks: number;
}

export interface EndpointData {
  id: number;
  publisher: string;
  url: string;
  pricePerCall: string;
  paymaster: string;
  active: boolean;
  totalCalls: number;
  totalRevenue: string;
  registeredAt: Date;
  // Proxy metadata (fetched from server, not on-chain)
  proxyName?: string;
  requireWorldId?: boolean;
  // Live proxy traffic stats (in-memory on the server, resets on restart)
  proxyStats?: EndpointProxyStats;
  // Liveness probe results from the server's periodic checker
  liveness?: EndpointLiveness;
  // Current concurrent requests in-flight (0 = idle, >= maxConcurrent = saturated)
  inFlight?: number;
  maxConcurrent?: number;
  // "webpage" = pay-to-unlock URL, no concurrency limits apply.
  // "api"     = pay-per-call, maxConcurrent + timeout enforced.
  contentType?: "webpage" | "api";
}

const INITIAL: OnChainData = {
  deployerBalance: "—",
  paymasterDeposit: "—",
  dailyBudget: "—",
  dailySpent: "—",
  remainingBudget: "—",
  totalCalls: 0,
  totalSponsored: "—",
  lastReset: null,
  totalEndpoints: 0,
  endpoints: [],
  lastUpdated: null,
  loading: true,
  error: null,
};

const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";

export function useOnChainData() {
  const [data, setData] = useState<OnChainData>(INITIAL);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER}/api/data/overview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const endpoints: EndpointData[] = (json.endpoints || [])
        .filter((ep: any) => ep.url)
        .map((ep: any) => ({
          id: ep.id,
          publisher: ep.publisher,
          url: ep.url,
          pricePerCall: (ep.pricePerCall / 1_000_000).toFixed(4),
          paymaster: ep.paymaster,
          active: ep.active,
          totalCalls: ep.totalCalls,
          totalRevenue: (ep.totalRevenue / 1_000_000).toFixed(4),
          registeredAt: new Date(ep.registeredAt * 1000),
          requireWorldId: ep.requireWorldId,
          proxyName: ep.name,
          proxyStats: ep.proxyStats,
          liveness: ep.liveness,
          inFlight: ep.inFlight ?? 0,
          maxConcurrent: ep.maxConcurrent,
          contentType: ep.contentType,
        }));

      // Aggregate "Total API Calls" from proxy stats — the on-chain paymaster
      // counter (json.paymaster.totalCalls) only ticks for ERC-4337 UserOps,
      // not for the x402 proxy path that publishers actually use.
      const aggregateCalls = endpoints.reduce(
        (s, e) => s + (e.proxyStats?.totalCalls ?? 0),
        0,
      );

      setData({
        deployerBalance:  parseFloat(json.deployer.balance).toFixed(4),
        paymasterDeposit: parseFloat(json.paymaster.deposit).toFixed(6),
        dailyBudget:      "—",
        dailySpent:       "—",
        remainingBudget:  "—",
        totalCalls:       aggregateCalls,
        totalSponsored:   parseFloat(json.paymaster.totalSponsored).toFixed(8),
        lastReset:        null,
        totalEndpoints:   endpoints.length,
        endpoints,
        lastUpdated:      new Date(),
        loading: false,
        error: null,
      });
    } catch (e: any) {
      setData((prev) => ({ ...prev, loading: false, error: e.message }));
    }
  }, []);

  useEffect(() => {
    setData({ ...INITIAL, loading: true });
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, refetch: fetchData };
}
