/**
 * send-userop.ts
 *
 * Sends a real ERC-4337 UserOperation on Base Sepolia using:
 *  - permissionless.js SimpleAccount (derived from AGENT_PRIVATE_KEY)
 *  - AgentGatePaymaster to sponsor gas (no cost to the agent)
 *  - Pimlico as the bundler
 *
 * Usage: tsx src/send-userop.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Hex,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createSmartAccountClient } from "permissionless";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  entryPoint07Address,
} from "viem/account-abstraction";
import { keccak256, toBytes } from "viem";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex;
const PIMLICO_API_KEY   = process.env.PIMLICO_API_KEY as string;

if (!AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY not set in .env");
if (!PIMLICO_API_KEY)   throw new Error("PIMLICO_API_KEY not set in .env");

const PAYMASTER_ADDRESS  = "0xddf2721Fd097Ed8e7998858C492a62d9D378626f" as Address;
const REGISTRY_ADDRESS   = "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2" as Address;
const ENTRYPOINT_ADDRESS = entryPoint07Address; // 0x0000000071727De22E5E9d8BAf0edAc6f37da032

// The endpoint being accessed — hash must match what's set in the paymaster
const ENDPOINT_URL       = "https://agentgate.demo/api/weather";

const PIMLICO_RPC = `https://api.pimlico.io/v2/84532/rpc?apikey=${PIMLICO_API_KEY}`;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("🤖 AgentGate — Real ERC-4337 UserOperation");
  console.log("=".repeat(60));

  // 1. Owner EOA (agent's key)
  const owner = privateKeyToAccount(AGENT_PRIVATE_KEY);
  console.log(`\n👤 Agent EOA:   ${owner.address}`);

  // 2. Public client (for on-chain reads)
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  // 3. Pimlico bundler client
  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_RPC),
    chain: baseSepolia,
    entryPoint: { address: ENTRYPOINT_ADDRESS, version: "0.7" },
  });

  // 4. SimpleAccount (deterministic, counterfactual if not yet deployed)
  const smartAccount = await toSimpleSmartAccount({
    client: publicClient,
    owner,
    entryPoint: { address: ENTRYPOINT_ADDRESS, version: "0.7" },
  });

  const accountAddress = smartAccount.address;
  const accountBalance = await publicClient.getBalance({ address: accountAddress });
  const isDeployed = (await publicClient.getCode({ address: accountAddress })) !== undefined;

  console.log(`📦 SimpleAccount: ${accountAddress}`);
  console.log(`   Balance:   ${Number(accountBalance) / 1e18} ETH`);
  console.log(`   Deployed:  ${isDeployed}`);

  // 5. Smart account client with our custom paymaster
  //    Our AgentGatePaymaster doesn't require off-chain signing — just include address.
  const smartAccountClient = createSmartAccountClient({
    account: smartAccount,
    chain: baseSepolia,
    bundlerTransport: http(PIMLICO_RPC),
    client: publicClient,
    paymaster: {
      // Stub data: paymaster address + endpoint hash encoded in paymasterData
      async getPaymasterStubData(_userOp) {
        return {
          paymaster: PAYMASTER_ADDRESS,
          paymasterData: endpointHash,  // bytes32 endpointHash at offset [52:84]
          paymasterVerificationGasLimit: 150000n,
          paymasterPostOpGasLimit: 80000n,
        };
      },
      // Actual paymaster data — same, no off-chain signature needed
      async getPaymasterData(_userOp) {
        return {
          paymaster: PAYMASTER_ADDRESS,
          paymasterData: endpointHash,
          paymasterVerificationGasLimit: 150000n,
          paymasterPostOpGasLimit: 80000n,
        };
      },
    },
    userOperation: {
      estimateFeesPerGas: async () => {
        const fees = await pimlicoClient.getUserOperationGasPrice();
        return {
          maxFeePerGas: fees.fast.maxFeePerGas,
          maxPriorityFeePerGas: fees.fast.maxPriorityFeePerGas,
        };
      },
    },
  });

  // 6. Build calldata — call the PublisherRegistry to read nextEndpointId (view-only demo)
  //    Alternatively: send 0 ETH to self (cheapest no-op call)
  // Compute endpoint hash — included in paymasterData so the paymaster knows the sponsorship %
  const endpointHash = keccak256(toBytes(ENDPOINT_URL)) as Hex;

  console.log(`\n⚙️  Paymaster:    ${PAYMASTER_ADDRESS}`);
  console.log(`   Registry:    ${REGISTRY_ADDRESS}`);
  console.log(`   Endpoint:    ${ENDPOINT_URL}`);
  console.log(`   EndpointHash:${endpointHash}`);
  console.log(`   Bundler:     Pimlico`);
  console.log(`   EntryPoint:  ${ENTRYPOINT_ADDRESS}`);

  console.log("\n📤 Sending UserOperation (gas sponsored by AgentGatePaymaster)...");

  // Simple no-op: send 0 ETH to self — proves the account can transact gas-free
  const userOpHash = await smartAccountClient.sendUserOperation({
    calls: [
      {
        to: accountAddress,  // send 0 ETH to self
        value: 0n,
        data: "0x",
      },
    ],
  });

  console.log(`\n✅ UserOperation submitted!`);
  console.log(`   UserOp Hash: ${userOpHash}`);
  console.log(`   🔗 https://www.jiffyscan.xyz/userOpHash/${userOpHash}?network=base-sepolia`);

  // 7. Wait for receipt
  console.log("\n⏳ Waiting for inclusion in a block...");
  const receipt = await pimlicoClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 120_000,
  });

  const txHash = receipt.receipt.transactionHash;
  console.log(`\n🎉 UserOperation INCLUDED!`);
  console.log(`   Tx Hash:  ${txHash}`);
  console.log(`   🔗 https://sepolia.basescan.org/tx/${txHash}`);
  console.log(`   Gas used: ${receipt.receipt.gasUsed}`);
  console.log(`   Status:   ${receipt.success ? "SUCCESS ✓" : "FAILED ✗"}`);

  if (receipt.success) {
    console.log("\n💡 The agent's gas was fully sponsored by AgentGatePaymaster.");
    console.log("   The agent paid ZERO ETH for this transaction.");
    console.log(`\n📊 Check paymaster stats on the dashboard:`);
    console.log(`   http://localhost:5173`);
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (err.details) console.error("   Details:", err.details);
  process.exit(1);
});
