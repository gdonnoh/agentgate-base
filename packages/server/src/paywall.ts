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
    transition: max-width 0.3s ease;
  }
  .card.chat-mode { max-width: 640px; }
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

  /* ── Chat UI ─────────────────────────────────────────────── */
  .chat-wrap { display: flex; flex-direction: column; gap: 14px; }
  .chat-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .chat-counter {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 10px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
  }
  .chat-counter.warn { color: #f59e0b; border-color: rgba(245, 158, 11, 0.35); }
  .chat-counter-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--success);
  }
  .chat-counter.warn .chat-counter-dot { background: #f59e0b; }
  .chat-model-select {
    width: 100%;
    padding: 10px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    cursor: pointer;
  }
  .chat-model-select:hover { border-color: var(--border-hover); }
  .chat-messages {
    display: flex; flex-direction: column; gap: 10px;
    max-height: 420px;
    overflow-y: auto;
    padding: 6px 2px;
  }
  .bubble {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 13.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .bubble.user {
    align-self: flex-end;
    background: var(--accent);
    color: white;
    border-bottom-right-radius: 4px;
  }
  .bubble.assistant {
    align-self: flex-start;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    color: var(--text);
    border-bottom-left-radius: 4px;
  }
  .bubble.typing {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--text-muted);
    font-style: italic;
  }
  .bubble.typing::before {
    content: "";
    display: inline-block;
    width: 10px; height: 10px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .chat-input-row {
    display: flex; align-items: flex-end; gap: 8px;
  }
  .chat-input {
    flex: 1;
    min-height: 42px;
    max-height: 140px;
    padding: 10px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 13.5px;
    line-height: 1.5;
    resize: none;
    outline: none;
  }
  .chat-input:focus { border-color: var(--accent); }
  .chat-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .chat-send {
    width: auto;
    padding: 0 18px;
    height: 42px;
    flex-shrink: 0;
  }
  .chat-empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
    padding: 24px 8px;
  }
  .chat-exhausted {
    text-align: center;
    padding: 20px;
    background: var(--surface-raised);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: var(--error);
    font-size: 13px;
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

<script>
  // No external imports — we talk to the wallet via window.ethereum and
  // encode USDC calls by hand. This avoids CORS/CDN flakiness and keeps
  // the page working without a build step.
  const ENDPOINT_ID = ${opts.endpointId};
  const PROXY_URL = ${JSON.stringify(opts.proxyUrl)};
  const PAYTO = ${JSON.stringify(opts.payTo)};
  const USDC_AMOUNT = BigInt(${JSON.stringify(opts.usdcAmount)});
  const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const CHAIN_ID_HEX = "0x14a34"; // 84532 Base Sepolia

  // ── Minimal ABI encoding helpers (no libs) ──
  // All USDC interaction goes through two function selectors:
  //   balanceOf(address)     → 0x70a08231
  //   transfer(address,uint) → 0xa9059cbb
  function padAddr(addr) { return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
  function padUint(n)    { return BigInt(n).toString(16).padStart(64, "0"); }
  function encBalanceOf(addr) { return "0x70a08231" + padAddr(addr); }
  function encTransfer(to, amount) { return "0xa9059cbb" + padAddr(to) + padUint(amount); }

  const connectBtn = document.getElementById("connectBtn");
  const payBtn = document.getElementById("payBtn");
  const status = document.getElementById("status");

  function showStatus(msg, type) {
    type = type || "info";
    status.innerHTML = (type === "info" ? '<span class="spinner"></span>' : "") + msg;
    status.className = "status show " + type;
  }
  function hideStatus() { status.className = "status"; }

  let userAddress = null;

  async function ensureBaseSepolia() {
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId === CHAIN_ID_HEX) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (e) {
      // 4902 = chain not known to the wallet yet → add it
      if (e && e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          }],
        });
      } else {
        throw e;
      }
    }
  }

  connectBtn.onclick = async function () {
    if (!window.ethereum) {
      showStatus("No wallet detected. Install MetaMask or Rabby.", "error");
      return;
    }
    try {
      showStatus("Connecting...", "info");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      userAddress = accounts[0];
      await ensureBaseSepolia();

      connectBtn.style.display = "none";
      payBtn.style.display = "block";
      payBtn.textContent = "Pay with " + userAddress.slice(0, 6) + "…" + userAddress.slice(-4);
      hideStatus();
    } catch (e) {
      showStatus("Connection failed: " + (e && (e.shortMessage || e.message) || String(e)), "error");
    }
  };

  const stepsEl = document.getElementById("steps");
  function setStep(n, state) {
    const el = stepsEl.querySelector('[data-step="' + n + '"]');
    if (!el) return;
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  }
  function completeStep(n) { setStep(n, "done"); }
  function activateStep(n) { setStep(n, "active"); }

  async function waitForReceipt(txHash, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 120000);
    while (Date.now() < deadline) {
      const receipt = await window.ethereum.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (receipt && receipt.blockNumber) return receipt;
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
    throw new Error("Transaction not confirmed within timeout");
  }

  // Server requires tx block depth >= 2 (anti-reorg guard). Poll the chain
  // until latestBlock - txBlock >= 2 so the verify call succeeds first try.
  async function waitForConfirmations(txBlockHex, minConfs, timeoutMs) {
    const txBlock = BigInt(txBlockHex);
    const needed = BigInt(minConfs || 2);
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      const latestHex = await window.ethereum.request({ method: "eth_blockNumber" });
      const latest = BigInt(latestHex);
      if (latest >= txBlock + needed) return;
      await new Promise(function (r) { setTimeout(r, 1500); });
    }
  }

  // Retry the server-side verify if it comes back with a "needs confirmations"
  // error — Base Sepolia blocks can lag between the wallet RPC and the server's
  // RPC by a second or two.
  async function verifyWithServerRetry(headers) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(PROXY_URL, { headers: headers });
      if (res.status === 200) return res;
      const bodyTxt = await res.clone().text();
      const needsConfs = /confirmation/i.test(bodyTxt);
      if (!needsConfs) return res; // permanent failure — let caller handle
      await new Promise(function (r) { setTimeout(r, 2500); });
    }
    // Last attempt: return whatever we get so the caller surfaces the error
    return await fetch(PROXY_URL, { headers: headers });
  }

  payBtn.onclick = async function () {
    try {
      payBtn.disabled = true;

      // Re-check chain (user may have switched away)
      await ensureBaseSepolia();

      // Pre-check USDC balance
      const balHex = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: USDC_ADDRESS, data: encBalanceOf(userAddress) }, "latest"],
      });
      const balance = BigInt(balHex || "0x0");
      if (balance < USDC_AMOUNT) {
        const need = Number(USDC_AMOUNT) / 1e6;
        const have = Number(balance) / 1e6;
        showStatus("Insufficient USDC. Need " + need + ", have " + have + '. <a href="https://faucet.circle.com/" target="_blank" style="color:inherit;text-decoration:underline">Get testnet USDC →</a>', "error");
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
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{
          from: userAddress,
          to: USDC_ADDRESS,
          data: encTransfer(PAYTO, USDC_AMOUNT),
        }],
      });
      completeStep(1);

      // Step 2: Broadcast
      activateStep(2);
      const txLink = document.getElementById("txLink");
      txLink.href = "https://sepolia.basescan.org/tx/" + txHash;
      txLink.textContent = txHash.slice(0, 10) + "..." + txHash.slice(-8) + " ↗";
      await new Promise(function (r) { setTimeout(r, 400); });
      completeStep(2);

      // Step 3: Wait for confirmation + 2 block depth (server enforces >= 2)
      activateStep(3);
      const receipt = await waitForReceipt(txHash);
      await waitForConfirmations(receipt.blockNumber, 2, 30000);
      completeStep(3);

      // Step 4: Server verifies (with automatic retry on "needs confirmations")
      activateStep(4);
      const res2 = await verifyWithServerRetry({
        "x-payment-tx": txHash,
        "x-payment-from": userAddress,
        "accept": "text/html",
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

      // Step 5: Redirect / render result
      activateStep(5);
      const ct = (res2.headers.get("content-type") || "").toLowerCase();
      if (ct.indexOf("application/json") >= 0) {
        const data = await res2.json();
        await new Promise(function (r) { setTimeout(r, 600); });
        completeStep(5);
        // Chat-session issuance (API-mode endpoint) — swap the card to the
        // in-browser chat UI instead of redirecting/rendering upstream HTML.
        if (data && data.sessionToken) {
          await new Promise(function (r) { setTimeout(r, 300); });
          renderChatUI(data);
          return;
        }
        if (data && data.redirect) {
          await new Promise(function (r) { setTimeout(r, 400); });
          window.location.href = data.redirect;
        }
      } else {
        // Upstream returned HTML / text — replace page with it.
        const html = await res2.text();
        completeStep(5);
        await new Promise(function (r) { setTimeout(r, 300); });
        document.open();
        document.write(html);
        document.close();
      }
    } catch (e) {
      showStatus((e && (e.shortMessage || e.message)) || String(e) || "Error", "error");
      payBtn.disabled = false;
      payBtn.style.display = "block";
      stepsEl.classList.remove("show");
    }
  };

  // ── Chat UI ────────────────────────────────────────────────────────────────
  // After successful payment for an API-mode endpoint, the server returns a
  // { sessionToken, pricingModel, budget, models[] } JSON payload instead of
  // a redirect. We swap the card's content to a full chat interface that
  // talks to /api/proxy/:id/api/chat via the session token.
  //
  // State kept in closure:
  //   messagesState: [{role, content}]  — full convo, NOT persisted across refresh
  //   remaining*   : live budget counter updated from x-session-remaining-* headers
  //   selectedModel: dropdown value (defaults to first entry in models[])
  //
  // When the server returns 402 we swap the input area for an "Exhausted —
  // Pay again" button that simply reloads the page so the user re-pays.
  function renderChatUI(data) {
    const card = document.querySelector(".card");
    card.classList.add("chat-mode");

    const endpointName = (data.endpointName || ("Endpoint #" + ENDPOINT_ID));
    const models = Array.isArray(data.models) ? data.models.slice() : [];
    const pricingModel = data.pricingModel || "per-call";
    const pricePerMillion = Number(data.pricePerMillionTokens) || 0;

    // Local state
    const messagesState = [];
    let selectedModel = models[0] || "";
    let remainingMicroUsdc = data.budget && data.budget.microUsdc ? BigInt(data.budget.microUsdc) : null;
    let remainingMessages  = data.budget && typeof data.budget.messages === "number" ? data.budget.messages : null;
    let exhausted = false;
    let pending = false;

    function escapeHtmlClient(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c;
      });
    }

    function formatCounter() {
      if (pricingModel === "per-token" && remainingMicroUsdc !== null) {
        const usd = Number(remainingMicroUsdc) / 1_000_000;
        let tokensLeft = "";
        if (pricePerMillion > 0) {
          const tokens = Math.floor((Number(remainingMicroUsdc) * 1) / pricePerMillion);
          const k = tokens >= 1000 ? (tokens / 1000).toFixed(1) + "k" : String(tokens);
          tokensLeft = " · " + k + " tokens";
        }
        return "$" + usd.toFixed(4) + " remaining" + tokensLeft;
      }
      if (remainingMessages !== null) {
        return remainingMessages + " messages left";
      }
      return "";
    }

    function counterLow() {
      if (pricingModel === "per-token" && remainingMicroUsdc !== null) {
        return remainingMicroUsdc < 1000n; // < $0.001
      }
      if (remainingMessages !== null) return remainingMessages <= 2;
      return false;
    }

    // Build the chat UI skeleton
    card.innerHTML = [
      '<div class="brand"><span class="brand-mark">\u25C6</span> AgentGate</div>',
      '<div class="chat-wrap">',
      '  <div class="chat-header">',
      '    <h1 style="margin:0; font-size:20px;">' + escapeHtmlClient(endpointName) + '</h1>',
      '    <span id="chatCounter" class="chat-counter">',
      '      <span class="chat-counter-dot"></span>',
      '      <span id="chatCounterText"></span>',
      '    </span>',
      '  </div>',
      (models.length > 1
        ? '  <select id="chatModel" class="chat-model-select">' +
          models.map(function (m) { return '<option value="' + escapeHtmlClient(m) + '">' + escapeHtmlClient(m) + '</option>'; }).join("") +
          '</select>'
        : ''),
      '  <div id="chatMessages" class="chat-messages">',
      '    <div id="chatEmpty" class="chat-empty">Say hello to ' + escapeHtmlClient(selectedModel || "the model") + '.</div>',
      '  </div>',
      '  <div id="chatInputWrap">',
      '    <div class="chat-input-row">',
      '      <textarea id="chatInput" class="chat-input" rows="1" placeholder="Type a message... (\u2318+Enter to send)"></textarea>',
      '      <button id="chatSend" class="chat-send">Send</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join("");

    const counterText = document.getElementById("chatCounterText");
    const counterEl   = document.getElementById("chatCounter");
    const messagesEl  = document.getElementById("chatMessages");
    const emptyEl     = document.getElementById("chatEmpty");
    const input       = document.getElementById("chatInput");
    const sendBtn     = document.getElementById("chatSend");
    const inputWrap   = document.getElementById("chatInputWrap");
    const modelSelect = document.getElementById("chatModel");

    function refreshCounter() {
      counterText.textContent = formatCounter();
      counterEl.classList.toggle("warn", counterLow());
    }
    refreshCounter();

    if (modelSelect) {
      modelSelect.addEventListener("change", function () {
        selectedModel = modelSelect.value;
      });
    }

    function appendBubble(role, content) {
      if (emptyEl) emptyEl.remove();
      const b = document.createElement("div");
      b.className = "bubble " + role;
      b.textContent = content;
      messagesEl.appendChild(b);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return b;
    }

    function appendTyping() {
      if (emptyEl) emptyEl.remove();
      const b = document.createElement("div");
      b.className = "bubble assistant typing";
      b.textContent = "typing\u2026";
      messagesEl.appendChild(b);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return b;
    }

    function setPending(p) {
      pending = p;
      input.disabled = p || exhausted;
      sendBtn.disabled = p || exhausted;
    }

    function showExhausted(msg) {
      exhausted = true;
      setPending(false);
      inputWrap.innerHTML = [
        '<div class="chat-exhausted">' + escapeHtmlClient(msg || "Session exhausted.") + '</div>',
        '<button id="payAgainBtn" style="margin-top:12px;">Pay again</button>',
      ].join("");
      document.getElementById("payAgainBtn").onclick = function () {
        window.location.reload();
      };
    }

    // Textarea auto-resize
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(140, input.scrollHeight) + "px";
    });

    async function sendMessage() {
      if (pending || exhausted) return;
      const text = (input.value || "").trim();
      if (!text) return;

      messagesState.push({ role: "user", content: text });
      appendBubble("user", text);
      input.value = "";
      input.style.height = "auto";
      setPending(true);

      const typingEl = appendTyping();

      try {
        const base = PROXY_URL.endsWith("/") ? PROXY_URL.slice(0, -1) : PROXY_URL;
        const reqBody = JSON.stringify({
          model: selectedModel,
          messages: messagesState,
          stream: false,
        });
        const reqHeaders = {
          "content-type": "application/json",
          "accept": "application/json",
          "x-agentgate-session": data.sessionToken,
        };

        // Auto-retry on 429 "Endpoint at capacity" — this happens when another
        // tab / agent is mid-inference on a maxConcurrent=1 Ollama endpoint.
        // The server honours Retry-After; we surface a "waiting in queue" state
        // and retry silently up to MAX_RETRIES before giving up.
        const MAX_RETRIES = 10;
        let res;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          res = await fetch(base + "/api/chat", {
            method: "POST", headers: reqHeaders, body: reqBody,
          });
          if (res.status !== 429) break;
          if (attempt === MAX_RETRIES) break;
          const retryAfter = Math.max(1, Number(res.headers.get("retry-after")) || 3);
          typingEl.textContent = "in queue (backend busy), retrying in " + retryAfter + "s…";
          await new Promise(function (r) { setTimeout(r, retryAfter * 1000); });
          typingEl.textContent = "typing…";
        }

        // Update counter from response headers (works on success or 402).
        const hMicro = res.headers.get("x-session-remaining-micro-usdc");
        const hMsgs  = res.headers.get("x-session-remaining-messages");
        if (hMicro !== null) { try { remainingMicroUsdc = BigInt(hMicro); } catch (_) {} }
        if (hMsgs  !== null) { remainingMessages = Number(hMsgs); }
        refreshCounter();

        if (res.status === 402) {
          typingEl.remove();
          showExhausted("Session budget exhausted. Pay again to continue.");
          return;
        }

        if (!res.ok) {
          typingEl.remove();
          const errTxt = await res.text();
          appendBubble("assistant", "Error: " + errTxt.slice(0, 500));
          setPending(false);
          return;
        }

        const body = await res.json();
        // Ollama /api/chat shape: { message: { role, content }, ... }
        const content =
          (body && body.message && typeof body.message.content === "string")
            ? body.message.content
            : (body && typeof body.response === "string")
              ? body.response
              : JSON.stringify(body);

        typingEl.remove();
        messagesState.push({ role: "assistant", content: content });
        appendBubble("assistant", content);
        refreshCounter();
        setPending(false);

        // Hit zero exactly? Lock the UI.
        if ((remainingMessages !== null && remainingMessages <= 0) ||
            (remainingMicroUsdc !== null && remainingMicroUsdc <= 0n)) {
          showExhausted("Session fully spent. Pay again to continue.");
        }
      } catch (err) {
        typingEl.remove();
        appendBubble("assistant", "Network error: " + ((err && (err.message || err)) || ""));
        setPending(false);
      }
    }

    sendBtn.onclick = sendMessage;
    input.addEventListener("keydown", function (e) {
      // Cmd/Ctrl + Enter sends; plain Enter inserts newline.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.focus();
  }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}
