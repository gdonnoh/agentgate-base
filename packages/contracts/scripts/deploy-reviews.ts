import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  console.log("\nDeploying ReviewRegistry...");
  const F = await ethers.getContractFactory("ReviewRegistry");
  const c = await F.deploy();
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("ReviewRegistry:", addr);
  console.log("Tx:", c.deploymentTransaction()?.hash);
  console.log("BaseScan: https://sepolia.basescan.org/address/" + addr);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
