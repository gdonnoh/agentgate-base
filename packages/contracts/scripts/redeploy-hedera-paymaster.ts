/**
 * redeploy-hedera-paymaster.ts
 *
 * Redeploys AgentGatePaymaster on Hedera Testnet with the try/catch fix
 * so fundAndSetGasShare no longer reverts when EntryPoint.depositTo fails.
 *
 * Run: npx hardhat run scripts/redeploy-hedera-paymaster.ts --network hederaTestnet
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const WEATHER_URL    = "https://agentgate.demo/api/weather";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n${"=".repeat(60)}`);
  console.log("🚀 AgentGate — Redeploy Paymaster on Hedera Testnet");
  console.log("=".repeat(60));
  console.log(`👤 Deployer: ${deployer.address}`);
  console.log(`💰 Balance:  ${ethers.formatEther(balance)} HBAR`);

  // ── 1. Deploy ─────────────────────────────────────────────────────────────
  console.log("\n⛽ [1/3] Deploying AgentGatePaymaster...");
  const PaymasterFactory = await ethers.getContractFactory("AgentGatePaymaster");
  const paymaster = await PaymasterFactory.deploy(ENTRYPOINT_V07, {
    gasLimit: 3_000_000,
  });
  await paymaster.waitForDeployment();

  const PAYMASTER = await paymaster.getAddress();
  const deployTx  = paymaster.deploymentTransaction()?.hash || "N/A";

  console.log(`✅ Paymaster: ${PAYMASTER}`);
  console.log(`   Tx:  ${deployTx}`);
  console.log(`   🔗  https://hashscan.io/testnet/contract/${PAYMASTER}`);

  // ── 2. Fund demo endpoint (should now succeed via try/catch) ──────────────
  console.log(`\n💸 [2/3] Funding demo endpoint (${WEATHER_URL})...`);
  const fundTx = await (paymaster as any).fundAndSetGasShare(
    WEATHER_URL,
    10000, // 100% gas share
    {
      value:    ethers.parseEther("0.05"),
      gasLimit: 500_000,
      gasPrice: ethers.parseUnits("1200", "gwei"),
    }
  );
  await fundTx.wait();

  const endpointHash  = ethers.keccak256(ethers.toUtf8Bytes(WEATHER_URL));
  const endpointBal   = await (paymaster as any).endpointBalance(endpointHash);
  console.log(`✅ Endpoint funded`);
  console.log(`   Tx:      ${fundTx.hash}`);
  console.log(`   Balance: ${ethers.formatEther(endpointBal)} HBAR`);

  // ── 3. Stake (optional, for ERC-4337 bundlers — may be a no-op on Hedera) ─
  console.log("\n🔒 [3/3] Staking (ERC-4337 — graceful on Hedera)...");
  try {
    const stakeTx = await (paymaster as any).addStake(86400, {
      value:    ethers.parseEther("0.001"),
      gasLimit: 300_000,
      gasPrice: ethers.parseUnits("550", "gwei"),
    });
    await stakeTx.wait();
    console.log(`✅ Staked. Tx: ${stakeTx.hash}`);
  } catch (e: any) {
    console.log(`⚠️  Stake skipped (not critical on Hedera): ${e.message?.slice(0, 80)}`);
  }

  // ── Update deployments.json ────────────────────────────────────────────────
  const deploymentsPath = path.resolve(__dirname, "../deployments.json");
  const all = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));

  const prev = all["hedera"] || {};
  all["hedera"] = {
    ...prev,
    paymaster:              PAYMASTER,
    paymasterDeployTxHash:  deployTx,
    fundTxHash:             fundTx.hash,
    deployedAt:             new Date().toISOString(),
    explorer: {
      ...prev.explorer,
      paymaster:         `https://hashscan.io/testnet/contract/${PAYMASTER}`,
      paymasterDeployTx: `https://hashscan.io/testnet/tx/${deployTx}`,
      fundTx:            `https://hashscan.io/testnet/tx/${fundTx.hash}`,
    },
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(all, null, 2));
  console.log("\n📄 deployments.json updated");

  console.log(`\n${"=".repeat(60)}`);
  console.log("🎉 HEDERA PAYMASTER DEPLOYED & FUNDED");
  console.log("=".repeat(60));
  console.log(`AgentGatePaymaster: ${PAYMASTER}`);
  console.log(`Demo endpoint bal:  ${ethers.formatEther(endpointBal)} HBAR`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message);
  process.exit(1);
});
