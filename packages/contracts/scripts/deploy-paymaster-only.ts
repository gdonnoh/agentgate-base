import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = process.env.HARDHAT_NETWORK || "hardhat";
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n${"=".repeat(60)}`);
  console.log("🚀 AgentGate — Deploy Paymaster Only");
  console.log("=".repeat(60));
  console.log(`📡 Network:  ${networkName}`);
  console.log(`👤 Deployer: ${deployer.address}`);
  console.log(`💰 Balance:  ${ethers.formatEther(balance)} ETH`);

  // ── 1. Deploy AgentGatePaymaster ───────────────────────────────────────────
  console.log("\n⛽ [1/3] Deploying AgentGatePaymaster...");
  const dailyBudget = ethers.parseEther("0.01");
  const PaymasterFactory = await ethers.getContractFactory("AgentGatePaymaster");
  const paymaster = await PaymasterFactory.deploy(ENTRYPOINT_V07, dailyBudget);
  await paymaster.waitForDeployment();

  const paymasterAddress = await paymaster.getAddress();
  const deployTxHash = paymaster.deploymentTransaction()?.hash || "N/A";

  console.log(`✅ AgentGatePaymaster: ${paymasterAddress}`);
  console.log(`   Tx:  ${deployTxHash}`);
  console.log(`   🔗  https://sepolia.basescan.org/address/${paymasterAddress}`);

  // Verify it works
  const dp = await (paymaster as any).dailyBudget();
  console.log(`   dailyBudget: ${ethers.formatEther(dp)} ETH ✓`);

  // ── 2. Deposit via EntryPoint ──────────────────────────────────────────────
  console.log("\n💸 [2/3] Depositing 0.005 ETH via EntryPoint...");
  const entryPoint = new ethers.Contract(
    ENTRYPOINT_V07,
    [
      "function depositTo(address account) external payable",
      "function balanceOf(address account) view returns (uint256)",
    ],
    deployer
  );
  const depositTx = await entryPoint.depositTo(paymasterAddress, {
    value: ethers.parseEther("0.005"),
  });
  await depositTx.wait();
  const depositBalance = await entryPoint.balanceOf(paymasterAddress);
  console.log(`✅ Deposited — EP balance: ${ethers.formatEther(depositBalance)} ETH`);
  console.log(`   Tx: ${depositTx.hash}`);

  // ── 3. Stake via Paymaster ─────────────────────────────────────────────────
  console.log("\n🔒 [3/3] Staking 0.001 ETH (unstakeDelay=86400s)...");
  const stakeTx = await (paymaster as any).addStake(86400, {
    value: ethers.parseEther("0.001"),
    gasLimit: 300000,
  });
  await stakeTx.wait();
  console.log(`✅ Staked!`);
  console.log(`   Tx: ${stakeTx.hash}`);

  // ── Update deployments.json ────────────────────────────────────────────────
  const deploymentsPath = path.resolve(__dirname, "../deployments.json");
  const all = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));

  const prev = all["baseSepolia"] || {};
  all["baseSepolia"] = {
    ...prev,
    paymaster: paymasterAddress,
    paymasterDeployTxHash: deployTxHash,
    fundTxHash: depositTx.hash,
    stakeTxHash: stakeTx.hash,
    deployedAt: new Date().toISOString(),
    explorer: {
      ...prev.explorer,
      paymaster: `https://sepolia.basescan.org/address/${paymasterAddress}`,
      paymasterDeployTx: `https://sepolia.basescan.org/tx/${deployTxHash}`,
    },
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(all, null, 2));
  console.log("\n📄 deployments.json updated");

  console.log(`\n${"=".repeat(60)}`);
  console.log("🎉 PAYMASTER DEPLOYED, FUNDED & STAKED");
  console.log("=".repeat(60));
  console.log(`AgentGatePaymaster: ${paymasterAddress}`);
  console.log(`EntryPoint deposit: ${ethers.formatEther(depositBalance)} ETH`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message);
  process.exit(1);
});
