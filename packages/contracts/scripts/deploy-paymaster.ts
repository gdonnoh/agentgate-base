import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  console.log("\nDeploying AgentGatePaymaster...");
  const F = await ethers.getContractFactory("AgentGatePaymaster");
  const p = await F.deploy("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log("Paymaster:", addr);
  console.log("Tx:", p.deploymentTransaction()?.hash);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
