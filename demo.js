const { ethers } = require("ethers");
const { formatSIWEMessage } = require("@worldcoin/agentkit");
const { x402Client } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { x402HTTPClient } = require("@x402/core/http");
const { decodePaymentRequiredHeader } = require("@x402/core/http");

require("dotenv").config();
const KEY = process.argv[2] || process.env.AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
const ENDPOINT = process.argv[3] || "https://agentgate.onrender.com/api/proxy/2";
if (!KEY) { console.error("Usage: node demo.js [PRIVATE_KEY] [ENDPOINT_URL]"); process.exit(1); }
const RPC = "https://sepolia.base.org";

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(KEY, provider);
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is AgentGate in 10 words?" }],
  });

  console.log("Agent:", wallet.address);

  // Step 1: 402
  console.log("\n[1] Calling endpoint...");
  const r1 = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const challenge = JSON.parse(
    Buffer.from(r1.headers.get("payment-required"), "base64").toString()
  );
  const acc = challenge.accepts[0];
  console.log(
    "    402 — Pay",
    (Number(BigInt(acc.amount)) / 1e6).toFixed(4),
    "USDC | WorldID required:",
    challenge.requireWorldId
  );

  // Step 2: Build WorldID proof
  console.log("\n[2] Signing WorldID proof (SIWE)...");
  const nonce = Math.random().toString(36).slice(2, 18);
  const siweInfo = {
    domain: "agentgate.onrender.com",
    uri: ENDPOINT,
    version: "1",
    chainId: "eip155:84532",
    type: "eip191",
    nonce,
    issuedAt: new Date().toISOString(),
    statement: "Verify your agent is backed by a real human",
  };
  const msg = formatSIWEMessage(siweInfo, wallet.address);
  const sig = await wallet.signMessage(msg);
  const ak = Buffer.from(
    JSON.stringify({ ...siweInfo, address: wallet.address, signature: sig })
  ).toString("base64");
  console.log("    Signed!");

  // Step 3: Try free-trial
  console.log("\n[3] Trying free-trial (WorldID only, no payment)...");
  const r2 = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", agentkit: ak },
    body,
  });
  console.log("    Status:", r2.status);
  if (r2.status === 200) {
    const data = await r2.json();
    console.log(
      "\n    FREE TRIAL! OpenAI says:",
      data.choices?.[0]?.message?.content
    );
    return;
  }

  // Step 4: Pay USDC via x402
  const usdcAmount = Number(BigInt(acc.amount)) / 1e6;
  console.log(
    "\n[4] Free-trial used — paying",
    usdcAmount.toFixed(4),
    "USDC via x402..."
  );

  // Build x402 payment using ExactEvmScheme
  const walletSigner = {
    address: wallet.address,
    signTypedData: async (params) => {
      const { domain, types, message: value } = params;
      // ethers v6 signTypedData
      return wallet.signTypedData(domain, types, value);
    },
    signMessage: async (params) => wallet.signMessage(params.message || params),
    readContract: async (params) => {
      const contract = new ethers.Contract(params.address, params.abi, provider);
      return contract[params.functionName](...(params.args || []));
    },
    getTransactionCount: async (params) => {
      return provider.getTransactionCount(params.address || wallet.address);
    },
  };

  // Parse the fresh 402 from r2
  const payReqHeader2 = r2.headers.get("payment-required");
  const paymentRequired = decodePaymentRequiredHeader(payReqHeader2);

  const evmScheme = new ExactEvmScheme(walletSigner);
  const coreClient = new x402Client().register("eip155:*", evmScheme);
  const httpClient = new x402HTTPClient(coreClient);
  const paymentPayload = await coreClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  // Re-sign agentkit with fresh nonce
  const nonce2 = Math.random().toString(36).slice(2, 18);
  const si2 = { ...siweInfo, nonce: nonce2, issuedAt: new Date().toISOString() };
  const sig2 = await wallet.signMessage(
    formatSIWEMessage(si2, wallet.address)
  );
  const ak2 = Buffer.from(
    JSON.stringify({ ...si2, address: wallet.address, signature: sig2 })
  ).toString("base64");

  // Step 5: Retry with payment + WorldID
  console.log("\n[5] Retrying with USDC payment + WorldID...");
  const r3 = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      agentkit: ak2,
      ...paymentHeaders,
    },
    body,
  });
  console.log("    Status:", r3.status);
  if (r3.status === 200) {
    const data = await r3.json();
    console.log(
      "\n    OpenAI says:",
      data.choices?.[0]?.message?.content
    );
    console.log("\n    Paid:", usdcAmount.toFixed(4), "USDC on Base Sepolia");
  } else {
    console.log("    Error:", await r3.text());
  }
})().catch((e) => console.error(e.message));
