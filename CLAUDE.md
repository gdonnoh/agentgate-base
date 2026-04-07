# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is AgentGate

AgentGate is a pay-per-call API gateway for AI agents on Hedera Testnet. Publishers register API endpoints with per-call pricing, and agents pay in HBAR via the x402 payment protocol. Agents backed by a real human (via World ID / WorldCoin AgentKit) get a free trial (3 calls) before payment kicks in.

## Monorepo Structure

pnpm workspace with four packages:

- **packages/server** — Hono HTTP server. x402 payment middleware gates `/api/weather/:city` and `/api/prices/:token`. WorldCoin AgentKit verifies human-backed agents. `LocalFacilitatorClient` handles demo settlement; `HederaFacilitatorClient` verifies real HBAR payments via Mirror Node.
- **packages/dashboard** — React 18 + Vite 5 + Tailwind frontend. Publisher dashboard for registering endpoints, viewing stats, managing gas budgets. Reads on-chain data from PublisherRegistry and AgentGatePaymaster contracts via viem. Tab-based UI (Dashboard, Flow, Publish, Manage). Polls contract state every 12s via `useOnChainData` hook.
- **packages/contracts** — Solidity (0.8.24) + Hardhat. Two contracts: `PublisherRegistry` (endpoint CRUD, call tracking) and `AgentGatePaymaster` (ERC-4337 v0.7 paymaster with per-endpoint gas budgets and configurable gas-share %).
- **packages/agent** — Demo CLI agent that exercises the full x402 + AgentKit flow (402 challenge → SIWE signing → payment → retry). Also has `pay-hedera.ts` for real HBAR payment and `send-userop.ts` for ERC-4337 UserOps via Pimlico.

## Commands

```bash
# Install dependencies
pnpm install

# Dev (all packages in parallel — server on 4021, dashboard on 5173)
pnpm dev

# Dev individual packages
pnpm --filter @agentgate/server dev     # server on port 4021 (tsx hot-reload)
pnpm --filter @agentgate/dashboard dev  # vite dev server on port 5173
pnpm --filter @agentgate/agent demo     # run agent demo

# Build all
pnpm build

# Test (only contracts have tests — Hardhat + Chai)
pnpm test

# Run single contract test file
cd packages/contracts && npx hardhat test test/AgentGatePaymaster.test.ts

# Run tests matching a pattern
cd packages/contracts && npx hardhat test --grep "fundAndSetGasShare"

# Contracts
cd packages/contracts
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.ts --network hedera
npx hardhat run scripts/deploy-paymaster-only.ts --network hedera
npx hardhat run scripts/fund-paymaster.ts --network hedera
```

## Server Middleware & Route Order

The middleware chain in `packages/server/src/index.ts` is order-sensitive:

1. **Proxy routes** (`/api/proxy/*`) — mounted BEFORE x402, handles 402 internally with dynamic per-endpoint pricing from on-chain registry
2. **AgentKit enrichment** (`/api/weather/*`, `/api/prices/*`) — optionally validates `agentkit` header; wallet-only agents pass through to x402
3. **x402 payment middleware** — issues HTTP 402 challenges with price/network/AgentKit info; verifies payment signatures on retry
4. **Protected routes** — `GET /api/weather/:city` ($0.01), `GET /api/prices/:token` ($0.005)
5. **Publisher management** (`/api/publisher/*`) — unprotected endpoint registration and proxy config CRUD
6. **Request logger** — post-response logging with `[PAID]` flag

Routes are in `packages/server/src/routes/` (weather, prices, proxy, publisher). Services are in `packages/server/src/services/` (localFacilitator, hederaFacilitator, hbarRate, proxyStore, config).

## TypeScript Configuration

- Root `tsconfig.json`: ES2022 target, CommonJS, strict mode — used by contracts
- Server & agent: ES2022, NodeNext modules, emit to `dist/`
- Dashboard: ES2020, ESNext modules, JSX react-jsx, bundler resolution, no emit (Vite handles output)
- Dev runtime for server/agent: `tsx` (no compile step needed for dev)

## Key Architectural Details

- **x402 protocol**: Server returns HTTP 402 with base64-encoded `payment-required` header containing price, network, and AgentKit challenge info. Agents can retry with `payment-signature` header only (wallet-only) or with both `agentkit` + `payment-signature` headers. Route-level config specifies exact price scheme (e.g., $0.01 for weather, $0.005 for prices).
- **Hedera HBAR payments**: Prices are in USD, converted to tinybars at runtime using Mirror Node exchange rate API (`/api/v1/network/exchangerate`). 1 HBAR = 10^8 tinybars. Hedera EVM: 1 ETH (wei) = 100 HBAR = 10^18 tinybars. Mirror Node polling at `/api/v1/contracts/results/{txHash}` confirms payment with ~3s finality.
- **AgentKit (optional)**: WorldCoin AgentKit gives WorldID-verified agents 3 free API calls via `InMemoryAgentKitStorage` (resets on server restart — demo only, not persisted). Wallet-only agents (no AgentKit) can access all endpoints by paying HBAR directly — they get no free-trial and no account abstraction gas subsidies.
- **Paymaster gas share**: Publishers deposit ETH and set a `gasShareBps` (0–10000). The paymaster covers that % of agent gas costs per call. `paymasterAndData[52:84]` carries the `endpointHash = keccak256(url)`. Post-op refunds over-reserved balance.
- **Config**: All packages load `.env` from the repo root. Required env vars: `PRIVATE_KEY` (publisher), `AGENT_PRIVATE_KEY`, `HEDERA_ACCOUNT_ID`, `WORLD_APP_ID`, `PIMLICO_API_KEY`. See `.env.example` for full list. Server config is in `packages/server/src/config.ts`. Contract addresses and deployment info are hardcoded in `packages/dashboard/src/lib/chains.ts`. Contract ABIs are manually defined in `packages/dashboard/src/lib/abi.ts` (not auto-generated).
- **Network**: The project targets Hedera Testnet (chainId 296, RPC `https://testnet.hashio.io/api`, Mirror Node `https://testnet.mirrornode.hedera.com`). Base Sepolia config exists but is not actively used.

## Deployed Contracts (Hedera Testnet)

- PublisherRegistry: `0xFBCee3E39A0909549fbc28cac37141d01f946189`
- AgentGatePaymaster: `0xfbC79b8d8b7659ce21DD37b82f988b9134c262a1`
- EntryPoint (ERC-4337): `0x0000000071727De22E5E9d8BAf0edAc6f37da032`

## Known Quirks

- **Vite proxy**: `packages/dashboard/vite.config.ts` proxies `/api` and `/health` to `localhost:4021`, matching the server port.
- **Hedera gas price**: Hardcoded to 1200 Gwei in `hardhat.config.ts`; the dashboard fetches live gas price from Hedera JSON-RPC for cost estimates.
- **BasePaymaster import**: Uses `@account-abstraction/contracts/core/BasePaymaster`; Hedera-specific try/catch wraps EntryPoint deposit calls for compatibility.
- **No linter configured**: No ESLint, Prettier, or Biome config exists in the repo.
- **Tests only in contracts**: Server, agent, and dashboard packages have no test suites.
