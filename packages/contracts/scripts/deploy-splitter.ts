import { ethers } from "hardhat";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const platformWallet = deployer.address;
  const feeBps = 500; // 5%

  console.log("\nDeploying PaymentSplitter...");
  console.log("  USDC:", USDC_BASE_SEPOLIA);
  console.log("  Platform wallet:", platformWallet);
  console.log("  Fee: 5% (500 bps)");

  const F = await ethers.getContractFactory("PaymentSplitter");
  const c = await F.deploy(USDC_BASE_SEPOLIA, platformWallet, feeBps);
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("\nPaymentSplitter:", addr);
  console.log("Tx:", c.deploymentTransaction()?.hash);
  console.log("BaseScan: https://sepolia.basescan.org/address/" + addr);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
