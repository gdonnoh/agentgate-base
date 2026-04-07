import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = (await ethers.provider.getNetwork()).name;

  // Load deployment addresses
  const deploymentPath = path.resolve(__dirname, `../deployments/${network}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for network ${network}. Run deploy.ts first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const paymasterAddress = deployment.AgentGatePaymaster;

  console.log(`\n💸 Funding AgentGatePaymaster`);
  console.log(`📡 Network: ${network}`);
  console.log(`📍 Paymaster: ${paymasterAddress}`);
  console.log(`👤 Funder: ${deployer.address}`);

  const AgentGatePaymaster = await ethers.getContractFactory("AgentGatePaymaster");
  const paymaster = AgentGatePaymaster.attach(paymasterAddress) as any;

  const fundAmount = ethers.parseEther("0.05");
  console.log(`\n💰 Depositing ${ethers.formatEther(fundAmount)} ETH...`);

  const tx = await paymaster.deposit({ value: fundAmount });
  await tx.wait();

  const remaining = await paymaster.getRemainingBudget();
  console.log(`✅ Funded! Remaining daily budget: ${ethers.formatEther(remaining)} ETH`);
  console.log(`📋 Tx hash: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
