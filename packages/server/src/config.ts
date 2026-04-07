import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const config = {
  port: Number(process.env.PORT) || 4021,
  // Official x402 facilitator — supports eip155:84532 (Base Sepolia)
  facilitatorUrl:
    process.env.FACILITATOR_URL ||
    "https://www.x402.org/facilitator",
  publisherAddress:
    process.env.PUBLISHER_ADDRESS ||
    "0x000000000000000000000000000000000000dead",
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  // Platform fee: percentage taken from each call (5 = 5%)
  platformFeePct: Number(process.env.PLATFORM_FEE_PCT) || 5,
  // Platform wallet: receives the fee portion of payments
  platformAddress:
    process.env.PLATFORM_ADDRESS ||
    process.env.PUBLISHER_ADDRESS ||
    "0x000000000000000000000000000000000000dead",
};

export const BASE_SEPOLIA = "eip155:84532";

// USDC on Base Sepolia (6 decimals)
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
