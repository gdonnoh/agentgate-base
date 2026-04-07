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
import { callTracker, proxyStore } from "../services/proxyStore";

// ── Contract addresses ───────────────────────────────────────────────────────
const REGISTRY_ADDR  = "0x9Aa0797C0F5b4f72fD7a9271B318a957dB8232A3" as const;
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

// ── Simple in-memory cache (30s TTL) ────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;
let overviewCache: CacheEntry<any> | null = null;

function getCached<T>(entry: CacheEntry<T> | null): T | null {
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.data;
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

/**
 * GET /overview
 *
 * Returns global stats: deployer balance, paymaster deposit, totalCalls,
 * totalSponsored, all endpoints, and live gas price.
 * Cached for 30 seconds.
 */
dataRouter.get("/overview", async (c) => {
  const cached = getCached(overviewCache);
  if (cached) return c.json(cached);

  try {
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

    // Read all endpoints in parallel
    const endpointIds = Array.from({ length: endpointCount }, (_, i) => i);
    const endpoints = await Promise.all(endpointIds.map((id) => readEndpoint(id)));

    const result = {
      deployer: {
        address: DEPLOYER,
        balance: formatEther(deployerBalanceRaw),
      },
      paymaster: {
        address:        PAYMASTER_ADDR,
        deposit:        formatEther(paymasterDeposit),
        depositRaw:     paymasterDeposit.toString(),
        totalCalls:     Number(totalCalls),
        totalSponsored: formatEther(totalSponsored),
      },
      registry: {
        address:       REGISTRY_ADDR,
        endpointCount,
      },
      gasPrice: {
        wei:  gasPrice.toString(),
        gwei: Number(gasPrice) / 1e9,
      },
      endpoints,
      timestamp: Date.now(),
    };

    overviewCache = { data: result, timestamp: Date.now() };
    return c.json(result);
  } catch (err: any) {
    console.error("[data/overview] RPC error:", err.message);
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

        // Proxy call stats from in-memory tracker
        const proxyStats = callTracker.getStats(id);

        return {
          ...ep,
          paymaster: paymasterData,
          proxyStats,
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

    const proxyStats = callTracker.getStats(match.id);

    return c.json({
      ...match,
      paymaster: paymasterData,
      proxyStats,
    });
  } catch (err: any) {
    console.error("[data/endpoint-by-url] RPC error:", err.message);
    return c.json({ error: "Failed to read on-chain data", details: err.message }, 502);
  }
});

export default dataRouter;
