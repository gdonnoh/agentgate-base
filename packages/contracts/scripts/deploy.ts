import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ERC-4337 EntryPoint v0.7 — deployed on Hedera testnet and Base Sepolia
const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const HASHSCAN_BASE = "https://hashscan.io/testnet";
const BASESCAN_BASE = "https://sepolia.basescan.org";

function explorerTx(network: string, txHash: string): string {
  if (network === "hedera") return `${HASHSCAN_BASE}/tx/${txHash}`;
  if (network === "baseSepolia") return `${BASESCAN_BASE}/tx/${txHash}`;
  return txHash;
}

function explorerContract(network: string, address: string): string {
  if (network === "hedera") return `${HASHSCAN_BASE}/contract/${address}`;
  if (network === "baseSepolia") return `${BASESCAN_BASE}/address/${address}`;
  return address;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkObj = await ethers.provider.getNetwork();
  const networkName = process.env.HARDHAT_NETWORK || "hardhat";
  const chainId = Number(networkObj.chainId);
  const nativeCurrency = chainId === 296 ? "HBAR" : "ETH";

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n" + "=".repeat(60));
  console.log("🚀 AgentGate Contract Deployment");
  console.log("=".repeat(60));
  console.log(`📡 Network:   ${networkName} (chainId: ${chainId})`);
  console.log(`👤 Deployer:  ${deployer.address}`);
  console.log(`💰 Balance:   ${ethers.formatEther(balance)} ${nativeCurrency}`);
  console.log("=".repeat(60) + "\n");

  if (balance === 0n) {
    console.error("❌ Deployer has zero balance. Fund the address first:");
    if (networkName === "hedera") {
      console.error(`   Hedera portal: https://portal.hedera.com/`);
      console.error(`   Address: ${deployer.address}`);
    }
    process.exit(1);
  }

  const entryPointAddr = process.env.ENTRYPOINT_ADDRESS || ENTRYPOINT_V07;
  console.log(`⚙️  EntryPoint: ${entryPointAddr}`);

  // ── 1. Deploy PublisherRegistry ──────────────────────────────────────────
  console.log("\n📝 [1/4] Deploying PublisherRegistry...");
  const RegistryFactory = await ethers.getContractFactory("PublisherRegistry");
  const registry = await RegistryFactory.deploy({ gasLimit: 6_000_000 });
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();
  const registryTxHash = registry.deploymentTransaction()?.hash || "N/A";

  console.log(`✅ PublisherRegistry:  ${registryAddress}`);
  console.log(`   Tx:  ${registryTxHash}`);
  console.log(`   🔗  ${explorerContract(networkName, registryAddress)}`);

  // ── 2. Deploy AgentGatePaymaster ─────────────────────────────────────────
  console.log("\n⛽ [2/4] Deploying AgentGatePaymaster...");
  const PaymasterFactory = await ethers.getContractFactory("AgentGatePaymaster");
  const paymaster = await PaymasterFactory.deploy(entryPointAddr, { gasLimit: 6_000_000 });
  await paymaster.waitForDeployment();

  const paymasterAddress = await paymaster.getAddress();
  const paymasterTxHash = paymaster.deploymentTransaction()?.hash || "N/A";

  console.log(`✅ AgentGatePaymaster: ${paymasterAddress}`);
  console.log(`   Tx:  ${paymasterTxHash}`);
  console.log(`   🔗  ${explorerContract(networkName, paymasterAddress)}`);

  // ── 3. Register weather endpoint on-chain ────────────────────────────────
  console.log("\n🌐 [3/4] Registering weather endpoint on-chain...");
  const weatherUrl = "https://agentgate.demo/api/weather";
  const pricePerCall = 10000n; // $0.01 USD (6 decimals)

  const registerTx = await (registry as any).registerEndpoint(
    weatherUrl,
    pricePerCall,
    paymasterAddress
  );
  await registerTx.wait();
  const registerTxHash = registerTx.hash;

  console.log(`✅ Endpoint registered`);
  console.log(`   URL:   ${weatherUrl}`);
  console.log(`   Price: $0.01 USD (HBAR at settlement) | Paymaster: ${paymasterAddress}`);
  console.log(`   Tx:  ${registerTxHash}`);
  console.log(`   🔗  ${explorerTx(networkName, registerTxHash)}`);

  // ── 4. Fund Paymaster ────────────────────────────────────────────────────
  console.log(`\n💸 [4/4] Funding Paymaster gas budget with 0.005 ${nativeCurrency}...`);
  let fundTxHash = "skipped";
  try {
    const fundAmount = ethers.parseEther("0.005");
    // fundAndSetGasShare: deposit ETH and set 100% gas sponsorship in one call
    const fundTx = await (paymaster as any).fundAndSetGasShare(
      weatherUrl,
      10000, // 100% gas share
      { value: fundAmount, gasPrice: ethers.parseUnits("1200", "gwei") }
    );
    await fundTx.wait();
    fundTxHash = fundTx.hash;
    console.log(`✅ Paymaster funded (0.005 ${nativeCurrency}, 100% gas share)`);
    console.log(`   Tx:  ${fundTxHash}`);
    console.log(`   🔗  ${explorerTx(networkName, fundTxHash)}`);
  } catch (err: any) {
    console.warn(`⚠️  Funding skipped: ${err.message.split("\n")[0]}`);
  }

  // ── Save deployments.json ─────────────────────────────────────────────────
  const deploymentsPath = path.resolve(__dirname, "../deployments.json");
  let allDeployments: Record<string, any> = {};
  if (fs.existsSync(deploymentsPath)) {
    allDeployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  }

  const deployment = {
    network: networkName,
    chainId,
    deployer: deployer.address,
    publisherRegistry: registryAddress,
    paymaster: paymasterAddress,
    entryPoint: entryPointAddr,
    deployTxHash: registryTxHash,
    paymasterDeployTxHash: paymasterTxHash,
    registerEndpointTxHash: registerTxHash,
    fundTxHash,
    weatherEndpoint: weatherUrl,
    deployedAt: new Date().toISOString(),
    explorer: {
      publisherRegistry: explorerContract(networkName, registryAddress),
      paymaster: explorerContract(networkName, paymasterAddress),
      deployTx: explorerTx(networkName, registryTxHash),
      registerTx: explorerTx(networkName, registerTxHash),
    },
  };

  allDeployments[networkName] = deployment;
  fs.writeFileSync(deploymentsPath, JSON.stringify(allDeployments, null, 2));
  console.log(`\n📄 Saved → packages/contracts/deployments.json`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("🎉 DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`PublisherRegistry:     ${registryAddress}`);
  console.log(`AgentGatePaymaster:    ${paymasterAddress}`);
  console.log(`EntryPoint:            ${entryPointAddr}`);
  console.log(`\n🔗 ${networkName === "hedera" ? "HashScan" : "Basescan"} links:`);
  console.log(`   Registry:   ${explorerContract(networkName, registryAddress)}`);
  console.log(`   Paymaster:  ${explorerContract(networkName, paymasterAddress)}`);
  console.log(`   Deploy tx:  ${explorerTx(networkName, registryTxHash)}`);
  console.log(`   Register:   ${explorerTx(networkName, registerTxHash)}`);
  if (fundTxHash !== "skipped") {
    console.log(`   Fund tx:    ${explorerTx(networkName, fundTxHash)}`);
  }
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message);
  process.exit(1);
});
