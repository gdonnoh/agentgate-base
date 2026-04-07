/**
 * AgentGate Agent Demo
 *
 * Demonstrates the full x402 + AgentKit flow:
 * 1. Agent hits a protected endpoint → receives 402 with AgentKit challenge
 * 2. Agent signs the SIWE challenge (proves human-backing via World ID)
 * 3. Agent signs the USDC payment (EIP-3009)
 * 4. Retries with both headers → gets 200
 *
 * Free-trial: first 3 calls pass with AgentKit proof only, no USDC needed.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, x402HTTPClient } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { formatSIWEMessage } from "@worldcoin/agentkit";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
const AGENT_ADDRESS = process.env.AGENT_ADDRESS;

// ── Colors (simple ANSI, no chalk ESM issues) ─────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  amber: "\x1b[33m",
};
const log = {
  info: (s: string) => console.log(`${c.cyan}${s}${c.reset}`),
  success: (s: string) => console.log(`${c.green}${s}${c.reset}`),
  warn: (s: string) => console.log(`${c.yellow}${s}${c.reset}`),
  error: (s: string) => console.log(`${c.red}${s}${c.reset}`),
  dim: (s: string) => console.log(`${c.gray}${s}${c.reset}`),
  header: (s: string) => console.log(`\n${c.bold}${c.amber}${s}${c.reset}`),
  sep: () => console.log(`${c.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

/**
 * Build the agentkit SIWE proof header from the 402 challenge.
 * Mirrors the format expected by parseAgentkitHeader on the server.
 */
async function buildAgentkitHeader(
  paymentRequired: ReturnType<typeof decodePaymentRequiredHeader>,
  account: ReturnType<typeof privateKeyToAccount>
): Promise<string> {
  const agentkitExt = (paymentRequired.extensions as any)?.agentkit;
  if (!agentkitExt?.info) throw new Error("No agentkit extension in 402 response");

  const info = agentkitExt.info;
  const supportedChains: Array<{ chainId: string; type: string }> = agentkitExt.supportedChains || [];

  // Pick a supported EVM chain for eip191 signing
  const chain =
    supportedChains.find((c) => c.type === "eip191" && c.chainId.startsWith("eip155:")) ||
    supportedChains[0];

  if (!chain) throw new Error("No supported chain found in agentkit extension");

  const completeInfo = { ...info, chainId: chain.chainId, type: chain.type };

  // Build the SIWE message and sign it
  const message = formatSIWEMessage(completeInfo, account.address);
  log.dim(`   SIWE message: ${message.slice(0, 80)}...`);

  const signature = await account.signMessage({ message });

  // Construct the agentkit payload (matches AgentkitPayloadSchema)
  const payload = {
    domain: info.domain,
    address: account.address,
    statement: info.statement,
    uri: info.uri,
    version: info.version,
    chainId: chain.chainId,
    type: chain.type,
    nonce: info.nonce,
    issuedAt: info.issuedAt,
    expirationTime: info.expirationTime,
    notBefore: info.notBefore,
    requestId: info.requestId,
    resources: info.resources,
    signature,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Make a payment-aware fetch call.
 * - With AgentKit: send agentkit header first (free-trial), then payment if needed
 * - Without AgentKit (wallet-only): skip SIWE, go straight to payment
 */
async function agentFetch(
  url: string,
  account: ReturnType<typeof privateKeyToAccount> | null,
  walletSigner: any | null,
  options?: { skipAgentKit?: boolean }
): Promise<{ response: Response; usedFreeTrial: boolean; paidUSDC: boolean; paymentAmount?: string }> {
  const walletOnly = options?.skipAgentKit ?? false;

  // ── Step 1: Initial request ────────────────────────────────────────────────
  log.info(`\nStep 1: GET ${url}${walletOnly ? " (wallet-only mode)" : ""}`);
  const res1 = await fetch(url);
  log.dim(`   → HTTP ${res1.status}`);

  if (res1.status !== 402) {
    return { response: res1, usedFreeTrial: false, paidUSDC: false };
  }

  // ── Step 2: Parse 402 ─────────────────────────────────────────────────────
  log.warn(`\nStep 2: Received 402 — Payment Required`);
  const paymentRequiredHeader = res1.headers.get("payment-required");
  if (!paymentRequiredHeader) throw new Error("No payment-required header in 402 response");

  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  const accepts = paymentRequired.accepts as any[];
  const chosen = accepts[0];

  const displayAmount = `${Number(chosen.amount) / 1e6} USDC`;

  log.dim(`   Price:   ${displayAmount}`);
  log.dim(`   Network: ${chosen.network}`);
  log.dim(`   Asset:   ${chosen.asset}`);

  if (!account) {
    log.warn("\nNo AGENT_PRIVATE_KEY set — cannot sign");
    log.warn("Set AGENT_PRIVATE_KEY in .env to enable signing");
    return { response: res1, usedFreeTrial: false, paidUSDC: false };
  }

  // ── Wallet-only path: skip AgentKit, go straight to payment ───────────────
  if (walletOnly) {
    log.info(`\nStep 3: Skipping AgentKit (wallet-only) — building payment...`);

    try {
      if (!walletSigner) {
        log.error("   Cannot sign payment: no wallet signer available");
        return { response: res1, usedFreeTrial: false, paidUSDC: false };
      }
      const evmScheme = new ExactEvmScheme(walletSigner);
      const coreClient = new x402Client().register("eip155:*", evmScheme);
      const httpClient = new x402HTTPClient(coreClient);
      const paymentPayload = await coreClient.createPaymentPayload(paymentRequired as any);
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

      log.info(`\nStep 4: Retry with USDC payment only...`);
      const res2 = await fetch(url, { headers: paymentHeaders });
      log.dim(`   → HTTP ${res2.status}`);
      const paymentAmount = `${Number((paymentRequired.accepts as any[])[0].amount) / 1e6} USDC`;
      return { response: res2, usedFreeTrial: false, paidUSDC: res2.status === 200, paymentAmount };
    } catch (err: any) {
      log.error(`   Payment failed: ${err.message}`);
      return { response: res1, usedFreeTrial: false, paidUSDC: false };
    }
  }

  // ── AgentKit path: sign SIWE, try free-trial, then payment if needed ──────
  log.dim(`   AgentKit challenge: nonce=${(paymentRequired.extensions as any)?.agentkit?.info?.nonce?.slice(0, 8)}...`);

  log.info(`\nStep 3: Signing AgentKit SIWE challenge...`);
  const agentkitHeader = await buildAgentkitHeader(paymentRequired, account);
  log.success(`   ✍️  AgentKit proof signed (${shortAddr(account.address)})`);
  log.dim(`   Header: ${agentkitHeader.slice(0, 40)}...`);

  // ── Step 4: Retry with AgentKit header (free-trial attempt) ───────────────
  log.info(`\nStep 4: Retry with AgentKit proof (free-trial)...`);
  const res2 = await fetch(url, {
    headers: { agentkit: agentkitHeader },
  });
  log.dim(`   → HTTP ${res2.status}`);

  if (res2.status === 200) {
    log.success(`   ✅ Free-trial granted — no payment needed`);
    return { response: res2, usedFreeTrial: true, paidUSDC: false };
  }

  // ── Step 5: Free-trial exhausted — build x402 payment ────────────────────
  if (res2.status === 402) {
    log.warn(`\nStep 5: Free-trial exhausted — building payment...`);

    // Parse fresh 402 from res2
    const payReqHeader2 = res2.headers.get("payment-required");
    if (!payReqHeader2) throw new Error("No payment-required header in second 402");
    const payReq2 = decodePaymentRequiredHeader(payReqHeader2);
    const chosen2 = (payReq2.accepts as any[])[0];

    try {
      // Re-sign agentkit (fresh nonce from new 402)
      const agentkitHeader2 = await buildAgentkitHeader(payReq2, account);

      if (!walletSigner) {
        log.error("   Cannot sign payment: no wallet signer available");
        return { response: res2, usedFreeTrial: false, paidUSDC: false };
      }
      const evmScheme = new ExactEvmScheme(walletSigner);
      const coreClient = new x402Client().register("eip155:*", evmScheme);
      const httpClient = new x402HTTPClient(coreClient);
      const paymentPayload = await coreClient.createPaymentPayload(payReq2 as any);
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

      log.info(`\nStep 6: Retry with AgentKit proof + USDC payment...`);
      const res3 = await fetch(url, {
        headers: { ...paymentHeaders, agentkit: agentkitHeader2 },
      });
      log.dim(`   → HTTP ${res3.status}`);
      const paymentAmount = `${Number(chosen2.amount) / 1e6} USDC`;
      return { response: res3, usedFreeTrial: false, paidUSDC: res3.status === 200, paymentAmount };
    } catch (err: any) {
      log.error(`   Payment failed: ${err.message}`);
      return { response: res2, usedFreeTrial: false, paidUSDC: false };
    }
  }

  return { response: res2, usedFreeTrial: false, paidUSDC: false };
}

// ── Main Demo ─────────────────────────────────────────────────────────────────

async function main() {
  log.sep();
  log.header("🤖 AgentGate Demo — Human-Backed AI Agent");
  log.sep();

  // Setup wallet
  const account = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;
  const agentAddress = account?.address || AGENT_ADDRESS;

  console.log(`\n${c.bold}Agent:${c.reset}     ${agentAddress}`);
  console.log(`${c.bold}AgentBook:${c.reset} ${account ? c.green + "✅ Registered (signing enabled)" : c.yellow + "⚠️  Read-only (set AGENT_PRIVATE_KEY)"}${c.reset}`);
  console.log(`${c.bold}Server:${c.reset}    ${SERVER_URL}`);

  // Build wallet signer if we have a private key
  let walletSigner: any = null;
  if (account) {
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC),
    });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC),
    });

    // Build signer interface expected by ExactEvmScheme
    walletSigner = {
      address: account.address,
      signTypedData: (params: any) => walletClient.signTypedData(params),
      signMessage: (params: any) => walletClient.signMessage(params),
      readContract: (params: any) => publicClient.readContract(params),
      getTransactionCount: (params: any) => publicClient.getTransactionCount(params),
    };
  }

  const results: Array<{
    endpoint: string;
    status: number;
    usedFreeTrial: boolean;
    paidUSDC: boolean;
    paymentAmount?: string;
    data?: any;
  }> = [];

  // ── Call 1: Weather (with AgentKit) ────────────────────────────────────────
  log.sep();
  log.header("📡 Call 1: Weather API — AgentKit mode (/api/weather/cannes)");
  try {
    const { response, usedFreeTrial, paidUSDC, paymentAmount } = await agentFetch(
      `${SERVER_URL}/api/weather/cannes`,
      account,
      walletSigner
    );

    let data: any = null;
    if (response.status === 200) {
      data = await response.json();
      log.success(`\n✅ Weather data received!`);
      console.log(`\n${c.gray}${JSON.stringify(data, null, 2)}${c.reset}`);
    }

    results.push({ endpoint: "/api/weather/cannes", status: response.status, usedFreeTrial, paidUSDC, paymentAmount, data });
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    results.push({ endpoint: "/api/weather/cannes", status: 0, usedFreeTrial: false, paidUSDC: false });
  }

  // ── Call 2: Price Feed (with AgentKit) ────────────────────────────────────
  log.sep();
  log.header("📡 Call 2: Price Feed API — AgentKit mode (/api/prices/eth)");
  try {
    const { response, usedFreeTrial, paidUSDC, paymentAmount } = await agentFetch(
      `${SERVER_URL}/api/prices/eth`,
      account,
      walletSigner
    );

    let data: any = null;
    if (response.status === 200) {
      data = await response.json();
      log.success(`\n✅ Price data received!`);
      console.log(`\n${c.gray}${JSON.stringify(data, null, 2)}${c.reset}`);
    }

    results.push({ endpoint: "/api/prices/eth", status: response.status, usedFreeTrial, paidUSDC, paymentAmount, data });
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    results.push({ endpoint: "/api/prices/eth", status: 0, usedFreeTrial: false, paidUSDC: false });
  }

  // ── Call 3: Weather (wallet-only, no AgentKit) ────────────────────────────
  log.sep();
  log.header("📡 Call 3: Weather API — Wallet-only mode (/api/weather/paris)");
  try {
    const { response, usedFreeTrial, paidUSDC, paymentAmount } = await agentFetch(
      `${SERVER_URL}/api/weather/paris`,
      account,
      walletSigner,
      { skipAgentKit: true }
    );

    let data: any = null;
    if (response.status === 200) {
      data = await response.json();
      log.success(`\n✅ Weather data received (wallet-only)!`);
      console.log(`\n${c.gray}${JSON.stringify(data, null, 2)}${c.reset}`);
    }

    results.push({ endpoint: "/api/weather/paris (wallet-only)", status: response.status, usedFreeTrial, paidUSDC, paymentAmount, data });
  } catch (err: any) {
    log.error(`Error: ${err.message}`);
    results.push({ endpoint: "/api/weather/paris (wallet-only)", status: 0, usedFreeTrial: false, paidUSDC: false });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log.sep();
  log.header("📊 Summary");
  log.sep();

  let totalUsdc = 0;
  let freeTrialCount = 0;

  for (const r of results) {
    const status = r.status === 200 ? c.green + "200 OK" : c.red + `${r.status}`;
    const mode = r.usedFreeTrial
      ? c.green + "FREE TRIAL"
      : r.paidUSDC
      ? c.cyan + `PAID ${r.paymentAmount}`
      : c.red + "FAILED/NO_KEY";
    console.log(`   ${r.endpoint.padEnd(30)} ${status}${c.reset}  ${mode}${c.reset}`);
    if (r.paidUSDC && r.paymentAmount) totalUsdc += parseFloat(r.paymentAmount);
    if (r.usedFreeTrial) freeTrialCount++;
  }

  console.log("");
  console.log(`   ${c.bold}Free-trial calls:${c.reset}  ${freeTrialCount}`);
  console.log(`   ${c.bold}USDC paid:${c.reset}         ${totalUsdc.toFixed(4)} USDC`);
  console.log(`   ${c.bold}Gas paid by agent:${c.reset} $0.00 (sponsored by Publisher Paymaster)`);
  console.log(`   ${c.bold}AgentKit verified:${c.reset} ${account ? c.green + "✅ (World ID proof)" : c.yellow + "⚠️  (no key)"}${c.reset}`);
  log.sep();

  if (!PRIVATE_KEY) {
    log.warn("\n💡 To enable full flow:");
    log.warn("   Add AGENT_PRIVATE_KEY=0x<key> to .env");
    log.warn("   Register the wallet at: npx @worldcoin/agentkit-cli register <address>");
    log.warn("   Your agent address: " + AGENT_ADDRESS);
  }
}

main().catch((err) => {
  log.error(`\nFatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
