/**
 * Recovery script for Base Sepolia.
 * Contracts are already deployed — just finish registerEndpoint, fund, and save deployments.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const REGISTRY_ADDRESS  = "0xe5FC410c1E438D129949B9823C62CC153DD8C2F2";
const PAYMASTER_ADDRESS = "0xfb274b563b2c1f9f9b77cf0944b99b00c006e754";
const ENTRYPOINT_V07    = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const REGISTRY_TX  = "0x9c1653279c010f3b5b4b1dec4438d60d7deea56d00dc0512cb3d8dfc6f3c4dc4";
const PAYMASTER_TX = "0x6d6e17e9a9ad1a8ab781928168737ad8a00aa9d68079c65972312ea710f3269e";

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkObj = await ethers.provider.getNetwork();
  const chainId = Number(networkObj.chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n" + "=".repeat(60));
  console.log("🔧 AgentGate — Base Sepolia Recovery");
  console.log("=".repeat(60));
  console.log(`📡 Network:  baseSepolia (chainId: ${chainId})`);
  console.log(`👤 Deployer: ${deployer.address}`);
  console.log(`💰 Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log("=".repeat(60) + "\n");

  if (balance === 0n) {
    console.error("❌ Zero balance. Cannot proceed.");
    process.exit(1);
  }

  // Attach to already-deployed contracts
  const registry  = await ethers.getContractAt("PublisherRegistry",  REGISTRY_ADDRESS,  deployer);
  const paymaster = await ethers.getContractAt("AgentGatePaymaster", PAYMASTER_ADDRESS, deployer);

  console.log(`✅ Attached to PublisherRegistry:  ${REGISTRY_ADDRESS}`);
  console.log(`✅ Attached to AgentGatePaymaster: ${PAYMASTER_ADDRESS}\n`);

  // ── 1. Register weather endpoint ─────────────────────────────────────────
  const weatherUrl   = "https://agentgate.demo/api/weather";
  const pricePerCall = 10000n; // $0.01 USD (6 decimals)

  console.log("🌐 [1/2] Registering weather endpoint...");
  let registerTxHash = "skipped";
  try {
    const registerTx = await (registry as any).registerEndpoint(
      weatherUrl,
      pricePerCall,
      PAYMASTER_ADDRESS
    );
    await registerTx.wait();
    registerTxHash = registerTx.hash;
    console.log(`✅ Endpoint registered`);
    console.log(`   Tx: ${registerTxHash}`);
    console.log(`   🔗 https://sepolia.basescan.org/tx/${registerTxHash}`);
  } catch (err: any) {
    console.warn(`⚠️  registerEndpoint failed or already done: ${err.message.split("\n")[0]}`);
  }

  // ── 2. Fund paymaster via EntryPoint.depositTo ───────────────────────────
  console.log("\n💸 [2/2] Funding Paymaster with 0.005 ETH via EntryPoint...");
  let fundTxHash = "skipped";
  try {
    const entryPoint = new ethers.Contract(
      ENTRYPOINT_V07,
      ["function depositTo(address account) external payable"],
      deployer
    );
    const fundTx = await entryPoint.depositTo(PAYMASTER_ADDRESS, {
      value: ethers.parseEther("0.005"),
    });
    await fundTx.wait();
    fundTxHash = fundTx.hash;
    console.log(`✅ Paymaster funded`);
    console.log(`   Tx: ${fundTxHash}`);
    console.log(`   🔗 https://sepolia.basescan.org/tx/${fundTxHash}`);

    const balance = await entryPoint.getFunction("balanceOf")(PAYMASTER_ADDRESS).catch(() => "n/a");
    if (balance !== "n/a") console.log(`   Deposit balance: ${ethers.formatEther(balance)} ETH`);
  } catch (err: any) {
    console.warn(`⚠️  Funding failed: ${err.message.split("\n")[0]}`);
  }

  // ── Save deployments.json ─────────────────────────────────────────────────
  const deploymentsPath = path.resolve(__dirname, "../deployments.json");
  let all: Record<string, any> = {};
  if (fs.existsSync(deploymentsPath)) {
    all = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  }

  all["baseSepolia"] = {
    network: "baseSepolia",
    chainId,
    deployer: deployer.address,
    publisherRegistry: REGISTRY_ADDRESS,
    paymaster: PAYMASTER_ADDRESS,
    entryPoint: ENTRYPOINT_V07,
    deployTxHash: REGISTRY_TX,
    paymasterDeployTxHash: PAYMASTER_TX,
    registerEndpointTxHash: registerTxHash,
    fundTxHash,
    weatherEndpoint: weatherUrl,
    deployedAt: new Date().toISOString(),
    explorer: {
      publisherRegistry: `https://sepolia.basescan.org/address/${REGISTRY_ADDRESS}`,
      paymaster:         `https://sepolia.basescan.org/address/${PAYMASTER_ADDRESS}`,
      deployTx:          `https://sepolia.basescan.org/tx/${REGISTRY_TX}`,
      paymasterDeployTx: `https://sepolia.basescan.org/tx/${PAYMASTER_TX}`,
      registerTx:        registerTxHash !== "skipped" ? `https://sepolia.basescan.org/tx/${registerTxHash}` : "skipped",
      fundTx:            fundTxHash     !== "skipped" ? `https://sepolia.basescan.org/tx/${fundTxHash}`     : "skipped",
    },
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(all, null, 2));
  console.log(`\n📄 Saved → packages/contracts/deployments.json`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("🎉 BASE SEPOLIA — DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`PublisherRegistry:  ${REGISTRY_ADDRESS}`);
  console.log(`AgentGatePaymaster: ${PAYMASTER_ADDRESS}`);
  console.log(`EntryPoint:         ${ENTRYPOINT_V07}`);
  console.log(`\n🔗 Basescan:`);
  console.log(`   Registry:  https://sepolia.basescan.org/address/${REGISTRY_ADDRESS}`);
  console.log(`   Paymaster: https://sepolia.basescan.org/address/${PAYMASTER_ADDRESS}`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Recovery failed:", err.message);
  process.exit(1);
});
