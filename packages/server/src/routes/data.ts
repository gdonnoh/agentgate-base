/**
 * data.ts
 *
 * Public API routes that serve on-chain data to the dashboard frontend.
 * Reads from PublisherRegistry, AgentGatePaymaster, and EntryPoint contracts
 * on Base Sepolia. Includes a simple in-memory cache (30s TTL) for the
 * overview endpoint to avoid hammering the RPC.
 */

import { Hono } from "hono";
import {
  createPublicClient,
  http,
  formatEther,
  keccak256,
  toHex,
  toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { callTracker, proxyStore, hiddenEndpoints } from "../services/proxyStore";
import { getLivenessSummary } from "../services/liveness";
import { getInFlightCount } from "./proxy";

// ── Contract addresses ───────────────────────────────────────────────────────
const REGISTRY_ADDR  = "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2" as const;
const PAYMASTER_ADDR = "0xddf2721Fd097Ed8e7998858C492a62d9D378626f" as const;
const ENTRYPOINT     = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const DEPLOYER       = "0x05a7Ae061c14847e0B70f7851d76FC10289d69b0" as const;

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

// ── Viem client ──────────────────────────────────────────────────────────────
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

// ── ABIs (minimal, inline) ───────────────────────────────────────────────────
const REGISTRY_ABI = [
  {
    name: "nextEndpointId",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "endpoints",
    type: "function",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "id",              type: "uint256" },
      { name: "publisher",       type: "address" },
      { name: "url",             type: "string"  },
      { name: "pricePerCall",    type: "uint256" },
      { name: "paymaster",       type: "address" },
      { name: "active",          type: "bool"    },
      { name: "totalCalls",      type: "uint256" },
      { name: "totalRevenue",    type: "uint256" },
      { name: "registeredAt",    type: "uint256" },
      { name: "requireWorldId",  type: "bool"    },
    ],
    stateMutability: "view",
  },
  {
    name: "getPublisherEndpoints",
    type: "function",
    inputs: [{ name: "publisher", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
] as const;

const PAYMASTER_ABI = [
  {
    name: "totalCalls",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "getTotalSponsored",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "endpointBalance",
    type: "function",
    inputs: [{ name: "endpointHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "endpointGasShareBps",
    type: "function",
    inputs: [{ name: "endpointHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "endpointOwner",
    type: "function",
    inputs: [{ name: "endpointHash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const ENTRYPOINT_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── In-memory cache with stale-while-revalidate ─────────────────────────────
// Fresh hit: within CACHE_TTL_MS → serve as-is, no RPC hit
// Stale hit: between TTL and STALE_TTL → serve stale + attempt background refresh
// Outside STALE_TTL: fall through to a fresh fetch (or error if that also fails)
//
// This matters on Render because the free Base Sepolia public RPC
// (sepolia.base.org) rate-limits aggressively. If the refresh fetch fails,
// we'd rather keep serving last-known data than break the dashboard.
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS       = 30_000;      // 30s — "fresh"
const CACHE_STALE_TTL_MS = 10 * 60_000; // 10 min — still serve on RPC error
let overviewCache: CacheEntry<any> | null = null;
let overviewRefreshInFlight: Promise<any> | null = null;

function getFreshCached<T>(entry: CacheEntry<T> | null): T | null {
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.data;
}

function getStaleCached<T>(entry: CacheEntry<T> | null): T | null {
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_STALE_TTL_MS) return null;
  return entry.data;
}

/**
 * Strip fields that must NEVER leave the server for public callers.
 *
 * `backendUrl` and `name` (which is the backend hostname) are private to the
 * publisher — for webpage endpoints they ARE the product: buyers pay to learn
 * the URL. Showing them in /api/data/overview would give away the entire value
 * proposition for free. The Manage tab fetches /api/data/publisher/:address
 * instead, which returns the full object including these fields — the publisher
 * sees their own data because they own it.
 */
function redactPrivateEndpointFields(ep: any) {
  const { backendUrl, name, hasProxy, ...rest } = ep;
  return rest;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a single endpoint from the registry by ID */
async function readEndpoint(id: number) {
  const raw = (await client.readContract({
    address: REGISTRY_ADDR,
    abi: REGISTRY_ABI,
    functionName: "endpoints",
    args: [BigInt(id)],
  })) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint, boolean];

  const epId = Number(raw[0]);
  const proxyConfig = proxyStore.get(epId);
  // Pull live proxy traffic stats from the in-memory tracker. The on-chain
  // counters in raw[6]/raw[7] are written only by ERC-4337 paymaster flows;
  // direct x402 proxy calls bypass them, so we surface the proxy counter
  // alongside so the dashboard can aggregate real revenue.
  const proxyStats = callTracker.getStats(epId);
  const liveness = getLivenessSummary(epId);
  const inFlight = getInFlightCount(epId);
  return {
    id: epId,
    publisher:       raw[1],
    url:             raw[2],
    pricePerCall:    Number(raw[3]),
    paymaster:       raw[4],
    active:          raw[5],
    totalCalls:      Number(raw[6]),
    totalRevenue:    Number(raw[7]),
    registeredAt:    Number(raw[8]),
    requireWorldId:  raw[9],
    // Enriched from proxyStore
    name:            proxyConfig?.name,
    backendUrl:      proxyConfig?.backendUrl,
    hasProxy:        !!proxyConfig,
    // Capacity controls — set by publisher, enforced by the proxy route
    maxConcurrent:          proxyConfig?.maxConcurrent,
    paymentTimeoutSeconds:  proxyConfig?.paymentTimeoutSeconds,
    // What the publisher is selling — drives whether the dashboard
    // surfaces capacity/timeout controls (api) or hides them (webpage)
    contentType:            proxyConfig?.contentType,
    // Enriched from in-memory call tracker (resets on server restart)
    proxyStats,
    // Enriched from in-memory liveness checker (resets on server restart)
    liveness,
    // Current in-flight count from the concurrency gate, for "busy"/"ready"
    // computation in the dashboard.
    inFlight,
  };
}

/** Compute keccak256 hash of a URL string (matches Solidity keccak256(bytes(url))) */
function hashUrl(url: string): `0x${string}` {
  return keccak256(toHex(toBytes(url)));
}

/** Read paymaster data for a given endpoint URL */
async function readPaymasterData(url: string) {
  const epHash = hashUrl(url);

  const [balance, gasShareBps, owner] = await Promise.all([
    client.readContract({
      address: PAYMASTER_ADDR,
      abi: PAYMASTER_ABI,
      functionName: "endpointBalance",
      args: [epHash],
    }) as Promise<bigint>,
    client.readContract({
      address: PAYMASTER_ADDR,
      abi: PAYMASTER_ABI,
      functionName: "endpointGasShareBps",
      args: [epHash],
    }) as Promise<bigint>,
    client.readContract({
      address: PAYMASTER_ADDR,
      abi: PAYMASTER_ABI,
      functionName: "endpointOwner",
      args: [epHash],
    }) as Promise<`0x${string}`>,
  ]);

  return {
    endpointHash:  epHash,
    balance:       formatEther(balance),
    balanceRaw:    balance.toString(),
    gasShareBps:   Number(gasShareBps),
    owner,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────
const dataRouter = new Hono();

/** The actual RPC-heavy work of building the overview payload. */
async function buildOverview() {
  // Global reads in parallel
  const [deployerBalanceRaw, paymasterDeposit, totalCalls, totalSponsored, nextId, gasPrice] =
    await Promise.all([
      client.getBalance({ address: DEPLOYER }),
      client.readContract({
        address: ENTRYPOINT,
        abi: ENTRYPOINT_ABI,
        functionName: "balanceOf",
        args: [PAYMASTER_ADDR],
      }) as Promise<bigint>,
      client.readContract({
        address: PAYMASTER_ADDR,
        abi: PAYMASTER_ABI,
        functionName: "totalCalls",
      }) as Promise<bigint>,
      client.readContract({
        address: PAYMASTER_ADDR,
        abi: PAYMASTER_ABI,
        functionName: "getTotalSponsored",
      }) as Promise<bigint>,
      client.readContract({
        address: REGISTRY_ADDR,
        abi: REGISTRY_ABI,
        functionName: "nextEndpointId",
      }) as Promise<bigint>,
      client.getGasPrice(),
    ]);

  const endpointCount = Number(nextId);
  const endpointIds = Array.from({ length: endpointCount }, (_, i) => i);
  const endpoints = await Promise.all(endpointIds.map((id) => readEndpoint(id)));

  return {
    deployer: { address: DEPLOYER, balance: formatEther(deployerBalanceRaw) },
    paymaster: {
      address:        PAYMASTER_ADDR,
      deposit:        formatEther(paymasterDeposit),
      depositRaw:     paymasterDeposit.toString(),
      totalCalls:     Number(totalCalls),
      totalSponsored: formatEther(totalSponsored),
    },
    registry: { address: REGISTRY_ADDR, endpointCount },
    gasPrice: { wei: gasPrice.toString(), gwei: Number(gasPrice) / 1e9 },
    // Strip backend URL + hostname from the public listing, AND drop any
    // endpoint whose owner has chosen to hide it. The Manage tab uses
    // /publisher/:address which returns the full objects including hidden
    // ones (owner needs to see them to un-hide).
    endpoints: endpoints
      .filter((ep: any) => !hiddenEndpoints.isHiddenAnywhere(ep.id))
      .map(redactPrivateEndpointFields),
    timestamp: Date.now(),
  };
}

/**
 * GET /overview
 *
 * Returns global stats: deployer balance, paymaster deposit, totalCalls,
 * totalSponsored, all endpoints, and live gas price.
 *
 * Cache model (stale-while-revalidate):
 *   Fresh (≤30s):   return cached data, no RPC.
 *   Stale (≤10min): return cached data AND kick off a background refresh.
 *                   Protects the dashboard from temporary RPC rate limits.
 *   Expired (>10min) or no cache: block and fetch fresh.
 */
dataRouter.get("/overview", async (c) => {
  const fresh = getFreshCached(overviewCache);
  if (fresh) return c.json(fresh);

  const stale = getStaleCached(overviewCache);
  if (stale) {
    // Serve stale immediately; refresh in background so the next request
    // sees the new data. Avoid stampede with overviewRefreshInFlight.
    if (!overviewRefreshInFlight) {
      overviewRefreshInFlight = buildOverview()
        .then((result) => {
          overviewCache = { data: result, timestamp: Date.now() };
          return result;
        })
        .catch((err) => {
          console.warn(`[data/overview] background refresh failed (serving stale): ${err.message}`);
          return null;
        })
        .finally(() => {
          overviewRefreshInFlight = null;
        });
    }
    return c.json({ ...stale, _stale: true });
  }

  // No cache at all — must block. Reuse any in-flight refresh to avoid
  // duplicate RPC work if multiple clients hit this simultaneously.
  try {
    if (!overviewRefreshInFlight) {
      overviewRefreshInFlight = buildOverview()
        .then((result) => {
          overviewCache = { data: result, timestamp: Date.now() };
          return result;
        })
        .finally(() => {
          overviewRefreshInFlight = null;
        });
    }
    const result = await overviewRefreshInFlight;
    return c.json(result);
  } catch (err: any) {
    console.error("[data/overview] RPC error:", err.message);
    // Last-ditch: if we have ANY cached data (even beyond stale TTL), serve it
    // with an obvious marker rather than breaking the dashboard.
    if (overviewCache) {
      return c.json({ ...overviewCache.data, _stale: true, _error: err.message });
    }
    return c.json({ error: "Failed to read on-chain data", details: err.message }, 502);
  }
});

/**
 * GET /publisher/:address
 *
 * Returns all endpoints registered by a specific publisher address,
 * enriched with paymaster data and proxy call stats.
 */
dataRouter.get("/publisher/:address", async (c) => {
  const address = c.req.param("address") as `0x${string}`;

  try {
    // Get publisher's endpoint IDs from registry
    const ids = (await client.readContract({
      address: REGISTRY_ADDR,
      abi: REGISTRY_ABI,
      functionName: "getPublisherEndpoints",
      args: [address],
    })) as readonly bigint[];

    // Read each endpoint + paymaster data + proxy stats in parallel
    const endpoints = await Promise.all(
      ids.map(async (idBig) => {
        const id = Number(idBig);
        const ep = await readEndpoint(id);

        // Paymaster data (requires URL for hashing)
        let paymasterData = null;
        if (ep.url) {
          try {
            paymasterData = await readPaymasterData(ep.url);
          } catch (e: any) {
            console.warn(`[data/publisher] Paymaster read failed for endpoint #${id}:`, e.message);
          }
        }

        // proxyStats is already attached by readEndpoint(). Include the
        // hidden flag so the publisher can see which endpoints they've
        // hidden themselves and un-hide them from the Manage UI.
        return {
          ...ep,
          paymaster: paymasterData,
          hidden: hiddenEndpoints.isHidden(id, address),
        };
      })
    );

    return c.json({
      publisher: address,
      endpointCount: endpoints.length,
      endpoints,
    });
  } catch (err: any) {
    console.error(`[data/publisher] RPC error for ${address}:`, err.message);
    return c.json({ error: "Failed to read publisher data", details: err.message }, 502);
  }
});

/**
 * GET /endpoint-by-url?url=...
 *
 * Looks up an endpoint by its registered URL. Loops through all endpoints
 * to find a match, then returns endpoint data + paymaster info.
 */
dataRouter.get("/endpoint-by-url", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "Missing ?url= query parameter" }, 400);
  }

  try {
    const nextId = (await client.readContract({
      address: REGISTRY_ADDR,
      abi: REGISTRY_ABI,
      functionName: "nextEndpointId",
    })) as bigint;

    const count = Number(nextId);

    // Read all endpoints in parallel to find matching URL
    const allEndpoints = await Promise.all(
      Array.from({ length: count }, (_, i) => readEndpoint(i))
    );

    const match = allEndpoints.find((ep) => ep.url === url);
    if (!match) {
      return c.json({ error: "No endpoint found with that URL" }, 404);
    }

    // Enrich with paymaster data
    let paymasterData = null;
    try {
      paymasterData = await readPaymasterData(match.url);
    } catch (e: any) {
      console.warn(`[data/endpoint-by-url] Paymaster read failed:`, e.message);
    }

    // This route is public (anyone can look up by on-chain URL), so the
    // backend URL and hostname must be redacted. proxyStats is already
    // attached by readEndpoint().
    return c.json({
      ...redactPrivateEndpointFields(match),
      paymaster: paymasterData,
    });
  } catch (err: any) {
    console.error("[data/endpoint-by-url] RPC error:", err.message);
    return c.json({ error: "Failed to read on-chain data", details: err.message }, 502);
  }
});

export default dataRouter;
