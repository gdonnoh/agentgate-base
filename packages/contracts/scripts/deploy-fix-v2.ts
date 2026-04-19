import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PUBLISHING_FEE = 1_000_000n; // 1 USDC (6 decimals)
const PLATFORM_FEE_BPS = 500; // 5%
const BASESCAN = "https://sepolia.basescan.org";

async function main() {
  const [deployer] = await ethers.getSigners();
  const platformWallet = deployer.address;

  console.log("=".repeat(60));
  console.log("AgentGate Security-Hardened Redeploy v2");
  console.log("=".repeat(60));
  console.log("Deployer:        ", deployer.address);
  console.log("Balance:         ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("USDC:            ", USDC);
  console.log("Platform wallet: ", platformWallet);
  console.log("Publishing fee:  ", "1 USDC");
  console.log("Platform fee:    ", "5% (500 bps)");
  console.log("=".repeat(60), "\n");

  // 1. PaymentSplitter
  console.log("[1/5] Deploying PaymentSplitter...");
  const SplitterF = await ethers.getContractFactory("PaymentSplitter");
  const splitter = await SplitterF.deploy(USDC, platformWallet, PLATFORM_FEE_BPS);
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  const splitterTx = splitter.deploymentTransaction()?.hash ?? "";
  console.log(`      ${splitterAddr}`);
  console.log(`      tx ${splitterTx}`);

  // 2. PublisherRegistry
  console.log("\n[2/5] Deploying PublisherRegistry...");
  const RegistryF = await ethers.getContractFactory("PublisherRegistry");
  const registry = await RegistryF.deploy(USDC, platformWallet, PUBLISHING_FEE);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  const registryTx = registry.deploymentTransaction()?.hash ?? "";
  console.log(`      ${registryAddr}`);
  console.log(`      tx ${registryTx}`);

  // 3. ReviewRegistry
  console.log("\n[3/5] Deploying ReviewRegistry...");
  const ReviewF = await ethers.getContractFactory("ReviewRegistry");
  const review = await ReviewF.deploy();
  await review.waitForDeployment();
  const reviewAddr = await review.getAddress();
  const reviewTx = review.deploymentTransaction()?.hash ?? "";
  console.log(`      ${reviewAddr}`);
  console.log(`      tx ${reviewTx}`);

  // 4. Wire Registry -> Splitter
  console.log("\n[4/5] Wiring PublisherRegistry.setPaymentSplitter...");
  const wire1 = await (registry as any).setPaymentSplitter(splitterAddr);
  await wire1.wait();
  console.log(`      tx ${wire1.hash}`);

  // 5. Wire Splitter -> Registry
  console.log("\n[5/5] Wiring PaymentSplitter.setRegistryAddress...");
  const wire2 = await (splitter as any).setRegistryAddress(registryAddr);
  await wire2.wait();
  console.log(`      tx ${wire2.hash}`);

  // Save
  const deploymentsPath = path.resolve(__dirname, "../deployments.json");
  const all: Record<string, any> = fs.existsSync(deploymentsPath)
    ? JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"))
    : {};
  const prev = all.baseSepolia || {};
  all.baseSepolia = {
    ...prev,
    network: "baseSepolia",
    chainId: 84532,
    deployer: deployer.address,
    publisherRegistry: registryAddr,
    paymentSplitter: splitterAddr,
    reviewRegistry: reviewAddr,
    // keep the existing paymaster — its code was unchanged
    paymaster: prev.paymaster,
    entryPoint: prev.entryPoint || "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    deployTxHash: registryTx,
    paymentSplitterTxHash: splitterTx,
    reviewRegistryTxHash: reviewTx,
    wireRegistryTxHash: wire1.hash,
    wireSplitterTxHash: wire2.hash,
    redeployedAt: new Date().toISOString(),
    previous: {
      publisherRegistry: prev.publisherRegistry,
      paymentSplitter: prev.paymentSplitter,
      reviewRegistry: prev.reviewRegistry,
    },
    explorer: {
      publisherRegistry: `${BASESCAN}/address/${registryAddr}`,
      paymentSplitter: `${BASESCAN}/address/${splitterAddr}`,
      reviewRegistry: `${BASESCAN}/address/${reviewAddr}`,
      paymaster: prev.paymaster ? `${BASESCAN}/address/${prev.paymaster}` : undefined,
    },
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(all, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYED");
  console.log("=".repeat(60));
  console.log("PublisherRegistry:  ", registryAddr);
  console.log("PaymentSplitter:    ", splitterAddr);
  console.log("ReviewRegistry:     ", reviewAddr);
  console.log("Paymaster (kept):   ", prev.paymaster);
  console.log("=".repeat(60));
  console.log(`\nBaseScan:`);
  console.log(`  Registry  ${BASESCAN}/address/${registryAddr}`);
  console.log(`  Splitter  ${BASESCAN}/address/${splitterAddr}`);
  console.log(`  Reviews   ${BASESCAN}/address/${reviewAddr}`);
  console.log("\nUPDATE required:");
  console.log(" - packages/dashboard/src/lib/chains.ts (addresses)");
  console.log(" - Render env PUBLISHER_REGISTRY (if set)");
  console.log("");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
