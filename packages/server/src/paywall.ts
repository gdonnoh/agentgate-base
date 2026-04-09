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
  backendUrl: string;      // just for display (host), ONLY rendered in api mode
  requireWorldId: boolean;
  proxyUrl: string;        // the full proxy URL agents would call
  contentType: "webpage" | "api";
}

export function paywallHtml(opts: PaywallOptions): string {
  // In webpage mode the backend URL IS the product the buyer is paying to
  // unlock — showing even the hostname here would give the answer away for
  // free. Hide it entirely and let the endpoint name stand alone.
  const host = opts.contentType === "webpage"
    ? ""
    : (() => { try { return new URL(opts.backendUrl).hostname; } catch { return opts.backendUrl; } })();

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

  /* ── Step animation ─────────────────────────────────────── */
  .steps {
    display: none;
    flex-direction: column;
    gap: 14px;
    margin-top: 20px;
    padding: 20px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .steps.show { display: flex; }

  .step {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    opacity: 0.35;
    transition: opacity 0.4s ease;
  }
  .step.active { opacity: 1; }
  .step.done { opacity: 0.8; }

  .step-icon {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1.5px solid var(--border-hover);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    transition: all 0.3s ease;
    position: relative;
  }
  .step.active .step-icon {
    border-color: var(--accent);
    background: rgba(59, 130, 246, 0.1);
    color: var(--accent);
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15);
  }
  .step.done .step-icon {
    border-color: var(--success);
    background: var(--success);
    color: white;
  }
  .step.done .step-icon::before {
    content: "";
    position: absolute;
    width: 10px;
    height: 5px;
    border-left: 2px solid white;
    border-bottom: 2px solid white;
    transform: rotate(-45deg) translate(1px, -1px);
  }
  .step.done .step-icon > span { display: none; }
  .step.active .step-icon > span::after {
    content: "";
    display: block;
    width: 8px;
    height: 8px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .step.active .step-icon > span { color: transparent; }

  .step-content { flex: 1; min-width: 0; }
  .step-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
  }
  .step-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .step-link {
    display: inline-block;
    margin-top: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--accent);
    text-decoration: none;
    word-break: break-all;
  }
  .step-link:hover { text-decoration: underline; }

  /* Connector line between steps */
  .step:not(:last-child) {
    position: relative;
  }
  .step:not(:last-child)::after {
    content: "";
    position: absolute;
    left: 10.5px;
    top: 28px;
    bottom: -14px;
    width: 1px;
    background: var(--border);
  }
  .step.done:not(:last-child)::after {
    background: var(--success);
  }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark">◆</span> AgentGate</div>
  <h1>${escapeHtml(opts.endpointName)}</h1>
  ${host ? `<p class="host">${escapeHtml(host)}</p>` : ""}

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

  <div id="steps" class="steps">
    <div class="step" data-step="1">
      <div class="step-icon"><span>1</span></div>
      <div class="step-content">
        <div class="step-title">Sign USDC transfer</div>
        <div class="step-desc">Approve the payment in your wallet</div>
      </div>
    </div>
    <div class="step" data-step="2">
      <div class="step-icon"><span>2</span></div>
      <div class="step-content">
        <div class="step-title">Broadcast to Base Sepolia</div>
        <div class="step-desc">Transaction submitted to the blockchain</div>
        <a id="txLink" class="step-link" href="" target="_blank"></a>
      </div>
    </div>
    <div class="step" data-step="3">
      <div class="step-icon"><span>3</span></div>
      <div class="step-content">
        <div class="step-title">Wait for confirmation</div>
        <div class="step-desc">~2 seconds on Base Sepolia</div>
      </div>
    </div>
    <div class="step" data-step="4">
      <div class="step-icon"><span>4</span></div>
      <div class="step-content">
        <div class="step-title">Server verifies on-chain</div>
        <div class="step-desc">x402 gateway checks the Transfer event</div>
      </div>
    </div>
    <div class="step" data-step="5">
      <div class="step-icon"><span>5</span></div>
      <div class="step-content">
        <div class="step-title">Access granted</div>
        <div class="step-desc">Redirecting you to the content</div>
      </div>
    </div>
  </div>

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

  const stepsEl = document.getElementById("steps");
  function setStep(n, state) {
    const el = stepsEl.querySelector(\`[data-step="\${n}"]\`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  }
  function completeStep(n) { setStep(n, "done"); }
  function activateStep(n) { setStep(n, "active"); }

  payBtn.onclick = async () => {
    try {
      payBtn.disabled = true;

      // Pre-check balance (silent)
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

      // Hide buttons, show animated steps
      connectBtn.style.display = "none";
      payBtn.style.display = "none";
      stepsEl.classList.add("show");
      hideStatus();

      // Step 1: Sign USDC transfer
      activateStep(1);
      const txHash = await walletClient.writeContract({
        account: userAddress,
        address: USDC_ADDRESS,
        abi: [{ name: "transfer", type: "function", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }],
        functionName: "transfer",
        args: [getAddress(PAYTO), USDC_AMOUNT],
      });
      completeStep(1);

      // Step 2: Broadcast
      activateStep(2);
      const txLink = document.getElementById("txLink");
      txLink.href = \`https://sepolia.basescan.org/tx/\${txHash}\`;
      txLink.textContent = \`\${txHash.slice(0, 10)}...\${txHash.slice(-8)} ↗\`;
      await new Promise(r => setTimeout(r, 400));
      completeStep(2);

      // Step 3: Wait for confirmation
      activateStep(3);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      completeStep(3);

      // Step 4: Server verifies
      activateStep(4);
      const res2 = await fetch(PROXY_URL, {
        headers: {
          "x-payment-tx": txHash,
          "x-payment-from": userAddress,
          "accept": "text/html",
        },
      });

      if (res2.status !== 200) {
        const err = await res2.text();
        showStatus("Payment rejected: " + err, "error");
        payBtn.disabled = false;
        payBtn.style.display = "block";
        stepsEl.classList.remove("show");
        return;
      }
      completeStep(4);

      // Step 5: Redirect
      activateStep(5);
      const data = await res2.json();
      if (data.redirect) {
        await new Promise(r => setTimeout(r, 600));
        completeStep(5);
        await new Promise(r => setTimeout(r, 500));
        window.location.href = data.redirect;
      } else {
        completeStep(5);
      }
    } catch (e) {
      showStatus((e.shortMessage || e.message || "Error"), "error");
      payBtn.disabled = false;
      payBtn.style.display = "block";
      stepsEl.classList.remove("show");
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
