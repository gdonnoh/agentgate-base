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
        }));

      setData({
        deployerBalance:  parseFloat(json.deployer.balance).toFixed(4),
        paymasterDeposit: parseFloat(json.paymaster.deposit).toFixed(6),
        dailyBudget:      "—",
        dailySpent:       "—",
        remainingBudget:  "—",
        totalCalls:       json.paymaster.totalCalls,
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
