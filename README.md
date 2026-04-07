# Agentgate

Pay-per-call API gateway for AI agents on Hedera, using x402 protocol and WorldID verification.

## Description

AgentGate is a pay-per-call API gateway for AI agents built on Hedera Testnet. It solves a core problem in the agentic economy: how do autonomous AI agents discover, authenticate against, and pay for API services — without human intervention at every step.

For publishers, AgentGate provides a dashboard to register any API endpoint with per-call USD pricing, deposit HBAR to sponsor agent gas costs, and configure what percentage of gas to subsidize. Publishers compete on price, gas sponsorship, and uptime — creating a natural marketplace for API access.

For AI agents, AgentGate implements the x402 payment protocol: when an agent hits a protected endpoint, the server returns HTTP 402 with a payment challenge containing the price in tinybars, the recipient address, and an optional WorldCoin AgentKit challenge. The agent can then either prove it's backed by a real human (via WorldID/AgentKit) to unlock 3 free trial calls, or pay directly in HBAR. Payment verification happens via Hedera Mirror Node with ~3-second finality — no oracles, no bridges, no wrapped tokens.

The system supports two agent archetypes: human-backed agents that authenticate via WorldCoin's AgentKit (SIWE signature + AgentBook lookup on World Chain) and get free-trial access before paying, and wallet-only agents that skip verification and pay HBAR directly for every call. Both paths converge on the same on-chain settlement.

Publishers register endpoints on-chain via the PublisherRegistry contract (storing URL, USD price, paymaster address), then configure server-side proxy settings (backend URL, injected API keys, WorldID requirements) via EIP-191 signed messages. The proxy system means publishers can monetize any existing API — agents never see the real backend URL or API keys.

The AgentGatePaymaster (ERC-4337) lets publishers deposit ETH and set a gas-share percentage per endpoint. When agents submit UserOps, the paymaster reads the endpoint hash from paymasterAndData, reserves the publisher's share of max gas cost, then refunds the overage in post-op settlement. This creates market competition: endpoints with higher gas sponsorship attract more agent traffic.

## How it's made

AgentGate is a monorepo with four packages: a Hono HTTP server, a React+Vite dashboard, Solidity contracts (Hardhat), and a demo CLI agent.

The server (TypeScript/Hono) implements an order-sensitive middleware chain. Proxy routes mount before x402 middleware so they can handle 402 challenges internally with dynamic per-endpoint pricing read from on-chain state. The x402 layer issues payment challenges with prices converted from USD to tinybars at runtime using Hedera Mirror Node's exchange rate API (cached 60s). Payment verification queries Mirror Node's /api/v1/contracts/results/{txHash} endpoint — we wait 1.5s for indexing, verify the tx succeeded, check the recipient and amount, and protect against double-spend with an in-memory usedTxHashes Set that reserves immediately and releases on verification failure.

WorldCoin AgentKit integration uses @anthropic-ai/agentkit for SIWE challenge generation and @anthropic-ai/agentkit/server for verification. The server queries World Chain's AgentBook contract to check if an agent address was delegated by a WorldID-verified human. Verified agents get 3 free calls tracked in InMemoryAgentKitStorage (keyed by address:endpointId).

The contracts are particularly noteworthy. The AgentGatePaymaster implements ERC-4337 BasePaymaster with a per-endpoint gas budget model. Each endpoint gets its own balance and gasShareBps (0-10000). We had to distinguish "unset" from "0%" using a separate endpointGasShareIsSet mapping — unset defaults to 100%, while explicitly-set-to-0% means "I sponsor nothing." The paymaster uses try/catch around entryPoint.depositTo() so the same contract works on both Hedera (where EntryPoint behavior differs) and Base Sepolia.

The publisher proxy system is where it gets hacky in a good way. Publishers sign their proxy configuration (backend URL, injected headers, WorldID requirement) with EIP-191 messages. The server recovers the signer address, checks it matches the on-chain endpoint owner, and stores the config. API keys are injected server-side into upstream requests — agents never see them. This means any existing API can be monetized without modification.

The dashboard (React 18 + Vite 5 + Tailwind) polls on-chain state every 12 seconds via viem's readContract, showing live gas balances, call counts, and sponsored amounts. The publish flow is two-phase: first an on-chain tx to register the endpoint + fund the paymaster, then a signed POST to configure the proxy server-side.

Partner tech used: Hedera Testnet (chain + Mirror Node for payment verification + exchange rates), WorldCoin AgentKit (human verification + free-trial)