import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { LocalFacilitatorClient } from "./services/localFacilitator";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import {
  agentkitResourceServerExtension,
  createAgentBookVerifier,
  createAgentkitHooks,
  declareAgentkitExtension,
  InMemoryAgentKitStorage,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
} from "@worldcoin/agentkit";

import { config, BASE_SEPOLIA } from "./config";
import weatherRouter from "./routes/weather";
import pricesRouter from "./routes/prices";
import publisherRouter from "./routes/publisher";
import proxyRouter from "./routes/proxy";
import dataRouter from "./routes/data";
import { startLivenessChecker } from "./services/liveness";

const payTo = config.publisherAddress as `0x${string}`;

// ── AgentKit setup ────────────────────────────────────────────────────────────
// AgentBook verifier queries the World Chain contract to confirm the calling
// agent was delegated by a real human who has a World ID.
const agentBook = createAgentBookVerifier();
const storage   = new InMemoryAgentKitStorage();
const hooks     = createAgentkitHooks({
  agentBook,
  storage,
  // WorldID-verified agents get 3 free calls; after that they pay USDC like anyone else.
  // Agents without a valid AgentBook entry bypass the free-trial and go straight to payment.
  mode: { type: "free-trial", uses: 3 },
  onEvent: (event) => {
    switch (event.type) {
      case "agent_verified":
        console.log(`[AgentKit] ✅ Human-backed agent verified: ${event.address} (humanId: ${event.humanId?.slice(0, 10)}…) → free access granted`);
        break;
      case "agent_not_verified":
        console.log(`[AgentKit] ⚠ Agent ${event.address} not in World Chain AgentBook → payment required`);
        break;
      case "validation_failed":
        console.log(`[AgentKit] ✗ AgentKit header validation failed: ${event.error}`);
        break;
    }
  },
});

// ── x402 resource server ──────────────────────────────────────────────────────
// LocalFacilitatorClient: delegates to x402.org real facilitator for Base Sepolia
const facilitatorClient = new LocalFacilitatorClient() as any;

// Scheme for Base Sepolia — USDC payments (6 decimals, x402 handles conversion)
const baseSepoliaEvmScheme = new ExactEvmScheme();

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(BASE_SEPOLIA, baseSepoliaEvmScheme)
  .registerExtension(agentkitResourceServerExtension);

// ── Protected route definitions ───────────────────────────────────────────────
const agentkitExt = declareAgentkitExtension({
  statement: "Verify your agent is backed by a real human",
  mode: { type: "free-trial", uses: 3 },
});

const routes = {
  "GET /api/weather/:city": {
    accepts: [
      { scheme: "exact" as const, price: "$0.01",  network: BASE_SEPOLIA, payTo },
    ],
    extensions: agentkitExt,
  },
  "GET /api/prices/:token": {
    accepts: [
      { scheme: "exact" as const, price: "$0.005", network: BASE_SEPOLIA, payTo },
    ],
    extensions: agentkitExt,
  },
};

// ── AgentKit enrichment middleware ─────────────────────────────────────────────
// Optional: if an agentkit header is present, validate it and attach verification
// status for downstream hooks (free-trial). Wallet-only agents (no agentkit) pass
// through to x402 which issues a 402 challenge — they pay USDC directly.
//
// Flow:
//   no agentkit header → pass through to x402 (402 challenge includes agentkit info)
//   agentkit header present but invalid → 403 (bad proof is rejected)
//   agentkit valid but not in AgentBook → pass through (no free-trial, must pay)
//   agentkit valid + in AgentBook → pass through (free-trial via x402 hooks)

async function enrichAgentKit(c: any, next: () => Promise<void>) {
  const agentkitHeader = c.req.header("agentkit") ?? c.req.header("AGENTKIT");

  if (!agentkitHeader) {
    // No AgentKit proof — wallet-only agent. Let x402 issue the 402 challenge.
    // The 402 response includes agentkitExt info so agents learn it's available.
    return next();
  }

  try {
    const payload    = parseAgentkitHeader(agentkitHeader);
    const validation = await validateAgentkitMessage(payload, c.req.url);
    if (!validation.valid) {
      return c.json({ error: `Invalid AgentKit proof: ${validation.error}` }, 403);
    }

    const verification = await verifyAgentkitSignature(payload);
    if (!verification.valid || !verification.address) {
      return c.json({ error: `AgentKit signature invalid: ${verification.error}` }, 403);
    }

    const humanId = await agentBook.lookupHuman(verification.address, payload.chainId);
    if (!humanId) {
      console.log(`[AgentKit] ${verification.address} not in AgentBook — no free-trial, must pay`);
    } else {
      console.log(`[AgentKit] ✓ ${verification.address} verified (humanId: ${humanId.slice(0, 10)}…)`);
    }

    return next();
  } catch (e: any) {
    return c.json({ error: `AgentKit verification error: ${e.message}` }, 403);
  }
}

// ── Hono app ──────────────────────────────────────────────────────────────────
const app = new Hono();

// CORS — allow dashboard frontend (any origin for hackathon demo)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, agentkit, AGENTKIT, payment-signature, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, X-PAYMENT, x-payment-tx, x-payment-from",
  "Access-Control-Max-Age": "86400",
};

app.use("*", async (c, next) => {
  // Handle preflight BEFORE the route logic — return with CORS headers
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  await next();
  // Apply CORS headers to all responses
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    c.res.headers.set(k, v);
  }
});

// On-chain data routes — public, no payment required
app.route("/api/data", dataRouter);

// Proxy routes — mounted BEFORE x402 middleware; handle their own 402 flow
// so each endpoint can have its own dynamic price from the on-chain registry.
app.route("/api/proxy", proxyRouter);

// AgentKit enrichment — optional; wallet-only agents pass through to x402
app.use("/api/weather/*", enrichAgentKit);
app.use("/api/prices/*",  enrichAgentKit);

// Payment middleware (handles 402 challenge/response)
const httpServer = new x402HTTPResourceServer(resourceServer, routes as any).onProtectedRequest(
  hooks.requestHook
);
app.use(paymentMiddlewareFromHTTPServer(httpServer));

// Health check (unprotected)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    endpoints: 2,
    agentkit: "optional",
    version: "1.0.0",
    protectedRoutes: Object.keys(routes),
  });
});

// Mount protected routes
app.route("/api/weather", weatherRouter);
app.route("/api/prices", pricesRouter);

// Publisher management (unprotected)
app.route("/api/publisher", publisherRouter);

// Request logger
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const payment = c.req.header("X-PAYMENT-RESPONSE") ? " [PAID]" : "";
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms${payment}`);
});

// ── Start server (skip on Vercel — it uses the exported app directly) ────────
if (!process.env.VERCEL) {
serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`\n🚀 AgentGate Server running on port ${info.port}`);
    console.log(`\n📡 Protected endpoints:`);
    console.log(`   GET /api/weather/:city  — $0.01  USDC (Base Sepolia)`);
    console.log(`   GET /api/prices/:token  — $0.005 USDC (Base Sepolia)`);
    console.log(`\n🔀 Proxy endpoints (any registered API subscription):`);
    console.log(`   ANY /api/proxy/:endpointId  — USDC payment → forward to upstream`);
    console.log(`\n🔓 Public endpoints:`);
    console.log(`   GET  /health`);
    console.log(`   POST /api/publisher/proxy-config   — register proxy (wallet-signed)`);
    console.log(`   GET  /api/publisher/proxy-config/:id`);
    console.log(`\n🆔 AgentKit: OPTIONAL on /api/weather + /api/prices`);
    console.log(`   Verified agents → 3 free calls (free-trial), then USDC payment`);
    console.log(`   Wallet-only agents → USDC payment required (no free-trial)`);
    console.log(`💳 Payments to: ${payTo}\n`);
    // Start periodic liveness probes for registered endpoints.
    startLivenessChecker();
  }
);
}

export default app;
