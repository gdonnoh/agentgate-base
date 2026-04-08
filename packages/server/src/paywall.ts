/**
 * paywall.ts
 *
 * HTML paywall page shown to browsers when they hit a protected endpoint.
 * Lets users connect MetaMask, pay USDC, and view the content — no agent needed.
 */

interface PaywallOptions {
  endpointId: number;
  endpointName: string;
  priceUsd: number;
  usdcAmount: string;      // in 6-decimal units
  payTo: string;
  backendUrl: string;      // just for display (host)
  requireWorldId: boolean;
  proxyUrl: string;        // the full proxy URL agents would call
}

export function paywallHtml(opts: PaywallOptions): string {
  const host = (() => { try { return new URL(opts.backendUrl).hostname; } catch { return opts.backendUrl; } })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(opts.endpointName)} — AgentGate</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0a;
    --surface: #111111;
    --surface-raised: #161616;
    --border: #1e1e1e;
    --border-hover: #2a2a2a;
    --text: #e5e7eb;
    --text-dim: #9ca3af;
    --text-muted: #6b7280;
    --accent: #3b82f6;
    --success: #22c55e;
    --error: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    width: 100%;
    max-width: 440px;
  }
  .brand {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    margin-bottom: 24px;
  }
  .brand-mark { color: var(--accent); }
  h1 {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 8px;
    letter-spacing: -0.01em;
  }
  .host {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 28px;
  }
  .price-box {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 20px;
    text-align: center;
  }
  .price-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 500;
  }
  .price-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 34px;
    font-weight: 700;
    margin: 8px 0 2px;
    letter-spacing: -0.02em;
  }
  .price-usdc {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }
  .worldid-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    color: var(--accent);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 16px;
  }
  button {
    width: 100%;
    padding: 14px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  button:hover:not(:disabled) { background: #2563eb; transform: translateY(-1px); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.secondary {
    background: var(--surface-raised);
    color: var(--text);
    border: 1px solid var(--border);
  }
  button.secondary:hover:not(:disabled) { background: var(--border); }
  .status {
    margin-top: 16px;
    padding: 12px;
    border-radius: 6px;
    font-size: 13px;
    display: none;
  }
  .status.show { display: block; }
  .status.error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: var(--error); }
  .status.success { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); color: var(--success); }
  .status.info { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); color: var(--accent); }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer {
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
  }
  .footer a { color: var(--text-dim); text-decoration: none; }
  .footer a:hover { color: var(--text); }
  code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    background: var(--surface-raised);
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--text-dim);
  }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark">◆</span> AgentGate</div>
  <h1>${escapeHtml(opts.endpointName)}</h1>
  <p class="host">${escapeHtml(host)}</p>

  ${opts.requireWorldId ? `
  <div class="worldid-badge">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
    WorldID Verified Humans Only
  </div>
  ` : ""}

  <div class="price-box">
    <div class="price-label">Price to access</div>
    <div class="price-value">$${opts.priceUsd.toFixed(2)}</div>
    <div class="price-usdc">USDC on Base Sepolia</div>
  </div>

  <button id="connectBtn">Connect Wallet</button>
  <button id="payBtn" class="secondary" style="display:none; margin-top:8px;">Pay $${opts.priceUsd.toFixed(2)} & Access</button>

  <div id="status" class="status"></div>

  <div class="footer">
    Powered by <a href="https://github.com/gdonnoh/agentgate-base" target="_blank">AgentGate</a> · x402 Protocol
  </div>
</div>

<script type="module">
  import { createWalletClient, createPublicClient, custom, http, parseUnits, getAddress } from "https://esm.sh/viem@2.47.6";
  import { baseSepolia } from "https://esm.sh/viem@2.47.6/chains";

  const ENDPOINT_ID = ${opts.endpointId};
  const PROXY_URL = ${JSON.stringify(opts.proxyUrl)};
  const PAYTO = ${JSON.stringify(opts.payTo)};
  const USDC_AMOUNT = BigInt(${JSON.stringify(opts.usdcAmount)});
  const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

  const connectBtn = document.getElementById("connectBtn");
  const payBtn = document.getElementById("payBtn");
  const status = document.getElementById("status");

  function showStatus(msg, type = "info") {
    status.innerHTML = (type === "info" ? '<span class="spinner"></span>' : "") + msg;
    status.className = "status show " + type;
  }
  function hideStatus() { status.className = "status"; }

  let walletClient, publicClient, userAddress;

  connectBtn.onclick = async () => {
    if (!window.ethereum) {
      showStatus("No wallet detected. Install MetaMask or Rabby.", "error");
      return;
    }
    try {
      showStatus("Connecting...", "info");
      walletClient = createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
      publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
      const accounts = await walletClient.requestAddresses();
      userAddress = accounts[0];

      // Switch to Base Sepolia if needed
      const chainId = await walletClient.getChainId();
      if (chainId !== 84532) {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x14a34" }],
        });
      }

      connectBtn.style.display = "none";
      payBtn.style.display = "block";
      payBtn.textContent = \`Pay with \${userAddress.slice(0, 6)}…\${userAddress.slice(-4)}\`;
      hideStatus();
    } catch (e) {
      showStatus("Connection failed: " + (e.shortMessage || e.message), "error");
    }
  };

  payBtn.onclick = async () => {
    try {
      payBtn.disabled = true;

      // 1. Check USDC balance
      showStatus("Checking balance...", "info");
      const balance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
        functionName: "balanceOf",
        args: [userAddress],
      });
      if (balance < USDC_AMOUNT) {
        showStatus(\`Insufficient USDC. Need \${Number(USDC_AMOUNT) / 1e6}, have \${Number(balance) / 1e6}. <a href="https://faucet.circle.com/" target="_blank" style="color:inherit;text-decoration:underline">Get testnet USDC →</a>\`, "error");
        payBtn.disabled = false;
        return;
      }

      // 2. Check Permit2 allowance
      showStatus("Checking allowance...", "info");
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: [{ name: "allowance", type: "function", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
        functionName: "allowance",
        args: [userAddress, PERMIT2_ADDRESS],
      });
      if (allowance < USDC_AMOUNT) {
        showStatus("Approve Permit2 to spend USDC (one-time)...", "info");
        const tx = await walletClient.writeContract({
          account: userAddress,
          address: USDC_ADDRESS,
          abi: [{ name: "approve", type: "function", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }],
          functionName: "approve",
          args: [PERMIT2_ADDRESS, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }

      // 3. Fetch 402 challenge, sign permit2, send payment
      showStatus("Fetching payment challenge...", "info");
      const res1 = await fetch(PROXY_URL, { headers: { "accept": "application/json" } });
      const payReqHeader = res1.headers.get("payment-required");
      const challenge = JSON.parse(atob(payReqHeader));
      const req = challenge.accepts[0];

      // Build Permit2 authorization
      showStatus("Sign payment in your wallet...", "info");
      const now = Math.floor(Date.now() / 1000);
      const nonce = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join(""));
      const deadline = BigInt(now + 60);
      const validAfter = BigInt(now - 600);

      const domain = { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2_ADDRESS };
      const types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "Witness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        Witness: [
          { name: "to", type: "address" },
          { name: "validAfter", type: "uint256" },
        ],
      };

      // The spender is the x402 facilitator proxy address — we need to get it
      // For now, use a known x402 proxy or the payTo
      const spender = getAddress(PAYTO); // fallback

      const message = {
        permitted: { token: getAddress(USDC_ADDRESS), amount: USDC_AMOUNT },
        spender,
        nonce,
        deadline,
        witness: { to: getAddress(PAYTO), validAfter },
      };

      const signature = await walletClient.signTypedData({
        account: userAddress,
        domain,
        types,
        primaryType: "PermitWitnessTransferFrom",
        message,
      });

      // 4. Build payment payload and retry
      showStatus("Verifying payment...", "info");
      const paymentPayload = {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:84532",
        payload: {
          signature,
          permit2Authorization: {
            from: userAddress,
            permitted: { token: USDC_ADDRESS, amount: USDC_AMOUNT.toString() },
            spender,
            nonce: nonce.toString(),
            deadline: deadline.toString(),
            witness: { to: PAYTO, validAfter: validAfter.toString() },
          },
        },
      };

      const encoded = btoa(JSON.stringify(paymentPayload, (_, v) => typeof v === "bigint" ? v.toString() : v));
      const res2 = await fetch(PROXY_URL, {
        headers: { "payment-signature": encoded, "accept": "text/html" },
      });

      if (res2.status === 200) {
        showStatus("Payment confirmed! Loading content...", "success");
        const content = await res2.text();
        const contentType = res2.headers.get("content-type") || "text/html";

        if (contentType.includes("html")) {
          // Replace the whole page with the content
          document.open();
          document.write(content);
          document.close();
        } else if (contentType.includes("json")) {
          document.body.innerHTML = '<pre style="padding:20px;background:#111;color:#e5e7eb;border-radius:8px;overflow:auto;max-width:800px;margin:40px auto;font-family:JetBrains Mono,monospace;font-size:13px">' +
            escapeHtml(JSON.stringify(JSON.parse(content), null, 2)) + '</pre>';
        } else {
          document.body.innerHTML = '<pre style="padding:20px;max-width:800px;margin:40px auto">' + escapeHtml(content) + '</pre>';
        }
      } else {
        const err = await res2.text();
        showStatus("Payment rejected: " + err, "error");
        payBtn.disabled = false;
      }
    } catch (e) {
      showStatus((e.shortMessage || e.message || "Error"), "error");
      payBtn.disabled = false;
    }
  };

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}
