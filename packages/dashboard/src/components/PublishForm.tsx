import { useState, useEffect } from "react";
import { NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { REGISTRY_ABI, PAYMASTER_ABI } from "../lib/abi";
import { useWallet } from "../hooks/useWallet";

interface TestResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  contentType: string | null;
  bodyPreview: string;
  errorMsg?: string;
}

interface PublishResult {
  txHash:     string;
  networkId:  NetworkId;
  endpointId: number;
}

/** Accepts `0.03` or locale `0,03` — plain parseFloat would yield 0 for the latter. */
function parseDecimalInput(raw: string): number {
  const s = String(raw).trim().replace(/\s/g, "").replace(/,/g, ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Base URL agents use (on-chain URL / paymaster). */
function publicAgentGateBase(): string {
  return (import.meta.env.VITE_SERVER_URL || "http://localhost:4021").replace(/\/$/, "");
}

/** Health check URL: in dev without VITE_SERVER_URL, use same-origin + Vite proxy (avoids CORS). */
function healthCheckUrl(): string {
  if (import.meta.env.DEV && !import.meta.env.VITE_SERVER_URL) {
    return "/health";
  }
  return `${publicAgentGateBase()}/health`;
}

export function PublishForm() {
  const wallet = useWallet();

  const [url,           setUrl]           = useState("");
  const [price,         setPrice]         = useState("0.10");
  const [gasSharePct,   setGasSharePct]   = useState(100);
  const [gasDeposit,    setGasDeposit]    = useState("0.005");
  const [selectedNet] = useState<NetworkId>("baseSepolia");

  // Hardcoded gas price: 0.1 Gwei for Base Sepolia (L2 is cheap)
  const gasPrice = 100_000_000n;

  const [backendUrl,      setBackendUrl]      = useState("");
  const [headerRows,      setHeaderRows]      = useState<{key: string; val: string}[]>([{ key: "", val: "" }]);
  const [requireWorldId,  setRequireWorldId]  = useState(false);
  const [proxyDone,       setProxyDone]       = useState<string | null>(null);
  const [proxyError,      setProxyError]      = useState<string | null>(null);

  const [testing,       setTesting]       = useState(false);
  const [testResult,    setTestResult]    = useState<TestResult | null>(null);
  const [publishing,    setPublishing]    = useState(false);
  const [publishStep,   setPublishStep]   = useState("");
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError,  setPublishError]  = useState<string | null>(null);
  const [depositError,  setDepositError]  = useState<string | null>(null);
  const [depositDone,   setDepositDone]   = useState(false);

  // Auto-generate on-chain URL from next registry id
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";
        const res = await fetch(`${SERVER}/api/data/overview`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const n = json.registry.endpointCount;
        setUrl(`${publicAgentGateBase()}/api/proxy/${n}`);
      } catch {
        /* keep manual url */
      }
    })();
    return () => { cancelled = true; };
  }, [selectedNet]);

  const paymasterAddress = DEPLOYMENTS[selectedNet].paymaster;

  /** Auto-generate endpoint name from backend URL hostname. */
  function endpointNameFromUrl(): string {
    try { return new URL(backendUrl.trim()).hostname; }
    catch { return ""; }
  }

  // ── Test endpoint ─────────────────────────────────────────────────────────
  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);
    const t0 = Date.now();

    if (!backendUrl.trim()) {
      setTesting(false);
      setTestResult({
        ok: false, status: 0, statusText: "—", latencyMs: 0, contentType: null, bodyPreview: "",
        errorMsg: "Please enter your Backend URL above before testing.",
      });
      return;
    }
    try {
      const res = await fetch(healthCheckUrl(), { signal: AbortSignal.timeout(8000) });
      const latencyMs   = Date.now() - t0;
      const contentType = res.headers.get("content-type");
      const ok          = res.status === 200;
      let bodyPreview   = "";
      try {
        bodyPreview = ok
          ? `AgentGate server OK (${publicAgentGateBase()}).\n\nOn-chain URL: ${url.trim() || "(loading...)"}\nBackend: ${backendUrl.trim()}\n\nAfter publish, agents pay x402 and AgentGate forwards to your backend with injected headers.`
          : await res.text();
      } catch { bodyPreview = ""; }
      setTestResult({
        ok, status: res.status, statusText: res.statusText, latencyMs, contentType, bodyPreview,
        errorMsg: ok ? undefined : `Health check failed — is the server running? (${res.status})`,
      });
    } catch (e: any) {
      setTestResult({
        ok: false, status: 0, statusText: "Error", latencyMs: Date.now() - t0, contentType: null, bodyPreview: "",
        errorMsg: e.name === "TimeoutError"
          ? "Timeout — start AgentGate server (pnpm --filter @agentgate/server dev)"
          : e.message || String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  // ── Publish on-chain ──────────────────────────────────────────────────────
  async function handlePublish() {
    if (!testResult?.ok) return;
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    setDepositError(null);
    setDepositDone(false);
    setPublishStep("");

    try {
      const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";
      const overviewRes = await fetch(`${SERVER}/api/data/overview`);
      if (!overviewRes.ok) throw new Error(`Failed to fetch overview: HTTP ${overviewRes.status}`);
      const overviewJson = await overviewRes.json();
      const endpointId = overviewJson.registry.endpointCount;
      const endpointName = endpointNameFromUrl();

      // Step 1: Register on PublisherRegistry
      setPublishStep("1/2 Registering endpoint...");
      const priceNum = parseDecimalInput(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        throw new Error("Invalid price — use a decimal number (e.g. 0.03)");
      }
      const priceUnits = BigInt(Math.round(priceNum * 1_000_000));
      const regHash = await wallet.writeContract(
        selectedNet,
        DEPLOYMENTS[selectedNet].publisherRegistry,
        REGISTRY_ABI as any,
        "registerEndpoint",
        [url.trim(), priceUnits, paymasterAddress]
      );

      setPublishResult({ txHash: regHash, networkId: selectedNet, endpointId });

      // Set WorldID requirement on-chain (if enabled)
      if (requireWorldId) {
        try {
          setPublishStep("Setting WorldID requirement on-chain...");
          await wallet.writeContract(
            selectedNet,
            DEPLOYMENTS[selectedNet].publisherRegistry,
            REGISTRY_ABI as any,
            "setRequireWorldId",
            [BigInt(endpointId), true]
          );
        } catch (e: any) {
          console.warn("setRequireWorldId failed:", e.message);
        }
      }

      const gasNum = parseDecimalInput(gasDeposit);
      const totalSteps = (Number.isFinite(gasNum) && gasNum > 0 ? 1 : 0) + (backendUrl.trim() ? 1 : 0) + 1;
      let step = 1;

      // Step 2 (optional): Fund gas budget on the Paymaster
      if (Number.isFinite(gasNum) && gasNum > 0) {
        step++;
        setPublishStep(`${step}/${totalSteps} Depositing gas budget...`);
        const depositWei = BigInt(Math.round(gasNum * 1e18));
        const bps        = Math.round(gasSharePct * 100);
        try {
          await wallet.writeContract(
            selectedNet,
            paymasterAddress,
            PAYMASTER_ABI as any,
            "fundAndSetGasShare",
            [url.trim(), bps],
            depositWei
          );
          setDepositDone(true);
        } catch (fundErr: any) {
          setDepositError(fundErr.shortMessage || fundErr.message || String(fundErr));
        }
      }

      // Step 3 (optional): Activate proxy config
      if (backendUrl.trim()) {
        step++;
        setPublishStep(`${step}/${totalSteps} Activating proxy...`);
        try {
          const injectHeaders: Record<string, string> = {};
          for (const row of headerRows) {
            if (row.key.trim()) injectHeaders[row.key.trim()] = row.val.trim();
          }
          const timestamp = Date.now();
          const message   = `AgentGate proxy config\nendpointId: ${endpointId}\nbackendUrl: ${backendUrl.trim()}\ntimestamp: ${timestamp}`;
          const signature = await (window as any).ethereum.request({
            method: "personal_sign",
            params: [message, wallet.state.address],
          });
          const res = await fetch(`${SERVER}/api/publisher/proxy-config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              endpointId, name: endpointName || undefined,
              backendUrl: backendUrl.trim(),
              injectHeaders, requireWorldId,
              walletAddress: wallet.state.address,
              signature, timestamp,
            }),
          });
          const data = await res.json() as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setProxyDone(data.proxyUrl);
        } catch (proxyErr: any) {
          setProxyError(proxyErr.message || String(proxyErr));
        }
      }

      setPublishStep("");
    } catch (e: any) {
      const msg = e.shortMessage || e.message || String(e);
      setPublishError(msg);
    } finally {
      setPublishing(false);
      setPublishStep("");
    }
  }

  async function handleRetryDeposit() {
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }
    setPublishing(true);
    setDepositError(null);
    setPublishStep("Depositing gas budget...");
    try {
      const depositWei = BigInt(Math.round(parseDecimalInput(gasDeposit) * 1e18));
      const bps        = Math.round(gasSharePct * 100);
      await wallet.writeContract(
        selectedNet,
        paymasterAddress,
        PAYMASTER_ABI as any,
        "fundAndSetGasShare",
        [url.trim(), bps],
        depositWei
      );
      setDepositDone(true);
    } catch (e: any) {
      setDepositError(e.shortMessage || e.message || String(e));
    } finally {
      setPublishing(false);
      setPublishStep("");
    }
  }

  const wrongNetwork = wallet.state.connected && wallet.state.chainId !== NETWORKS[selectedNet].chainId;
  const canPublish   = testResult?.ok && !publishing && !publishResult;
  const gasDepositNum = parseDecimalInput(gasDeposit);
  const hasDeposit    = Number.isFinite(gasDepositNum) && gasDepositNum > 0;

  const GAS_PER_CALL   = 65_000n;
  const costPerCallWei = gasPrice * GAS_PER_CALL;
  const depositWei     = hasDeposit ? BigInt(Math.round(gasDepositNum * 1e18)) : 0n;
  const estCalls       = costPerCallWei > 0n && depositWei > 0n ? Number(depositWei / costPerCallWei) : 0;
  const endpointName   = endpointNameFromUrl();

  return (
    <div className="flex flex-col gap-6">

      {/* ── Hero text ── */}
      <div>
        <h2 className="text-lg font-semibold text-text mb-1 font-sans">Monetize any API or URL</h2>
        <p className="text-sm text-text-muted font-sans">
          Put any URL behind a paywall. AI agents pay per call, you earn USDC.
        </p>
      </div>

      {/* ── Backend URL ── */}
      <div className="flex flex-col gap-1.5">
        <label className="label">Backend URL</label>
        <input
          type="url"
          placeholder="https://api.openai.com/v1/chat/completions"
          value={backendUrl}
          onChange={(e) => setBackendUrl(e.target.value)}
          className="input"
        />
      </div>

      {/* ── Auth Headers ── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="label">
            Auth Headers
            <span className="text-text-muted/50 normal-case tracking-normal ml-1.5">
              optional — injected server-side, never exposed to agents
            </span>
          </label>
          <button
            onClick={() => setHeaderRows((r) => [...r, { key: "", val: "" }])}
            className="text-xs text-text-muted hover:text-text-dim border border-border rounded-sm px-2 py-0.5 transition-colors"
          >
            + Add header
          </button>
        </div>
        {headerRows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              placeholder="Authorization"
              value={row.key}
              onChange={(e) => setHeaderRows((r) => r.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
              className="input w-[35%] text-xs"
            />
            <span className="text-border text-sm">:</span>
            <input
              placeholder="Bearer sk-..."
              value={row.val}
              onChange={(e) => setHeaderRows((r) => r.map((x, j) => j === i ? { ...x, val: e.target.value } : x))}
              className="input flex-1 text-xs"
            />
            {headerRows.length > 1 && (
              <button
                onClick={() => setHeaderRows((r) => r.filter((_, j) => j !== i))}
                className="text-text-muted hover:text-error text-sm transition-colors"
              >
                x
              </button>
            )}
          </div>
        ))}
      </div>

      {/* ── Price ── */}
      <div className="flex flex-col gap-1.5">
        <label className="label">Price per call</label>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-lg">$</span>
          <input
            type="number"
            min="0"
            step="0.001"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="input w-28 text-center font-mono"
          />
          <span className="text-sm text-text-muted font-sans">per call (paid in USDC)</span>
        </div>
      </div>

      {/* ── Human Verification ── */}
      <div className="flex flex-col gap-1.5">
        <label className="label">Human Verification</label>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setRequireWorldId(false)}
            className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
              !requireWorldId ? "border-accent bg-accent-dim" : "hover:border-border-hover"
            }`}
          >
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              !requireWorldId ? "border-accent" : "border-border-hover"
            }`}>
              {!requireWorldId && <span className="w-2 h-2 rounded-full bg-accent" />}
            </span>
            <div>
              <div className="text-sm font-medium text-text font-sans">Anyone can access</div>
              <div className="text-xs text-text-muted font-sans mt-0.5">Pay USDC and use -- no identity proof needed</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setRequireWorldId(true)}
            className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
              requireWorldId ? "border-accent bg-accent-dim" : "hover:border-border-hover"
            }`}
          >
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              requireWorldId ? "border-accent" : "border-border-hover"
            }`}>
              {requireWorldId && <span className="w-2 h-2 rounded-full bg-accent" />}
            </span>
            <div>
              <div className="text-sm font-medium text-text font-sans">Verified humans only (WorldID)</div>
              <div className="text-xs text-text-muted font-sans mt-0.5">3 free calls, then pay USDC</div>
            </div>
          </button>
        </div>
      </div>

      {/* ── Gas Sponsorship ── */}
      <div className="flex flex-col gap-3">
        <div>
          <label className="label">Gas Sponsorship</label>
          <p className="text-xs text-text-muted mt-1">
            Agents prefer endpoints with free gas — it's like free shipping. Sponsor gas to get more traffic.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min="0"
            step="0.001"
            value={gasDeposit}
            onChange={(e) => setGasDeposit(e.target.value)}
            className="input w-28 text-center font-mono"
          />
          <span className="text-sm text-text-muted font-mono">ETH</span>
          <div className="flex-1 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={gasSharePct}
              onChange={(e) => setGasSharePct(Number(e.target.value))}
              className="flex-1 accent-accent cursor-pointer"
            />
            <span className={`font-mono text-sm font-bold min-w-[3ch] text-right ${
              gasSharePct >= 75 ? "text-success" : gasSharePct >= 40 ? "text-accent" : "text-error"
            }`}>
              {gasSharePct}%
            </span>
          </div>
        </div>
        <div className={`rounded-sm px-3 py-2 text-xs ${
          gasSharePct === 100
            ? "bg-success-dim border border-success/20 text-success"
            : gasSharePct >= 50
            ? "bg-accent-dim border border-accent/20 text-accent"
            : gasSharePct > 0
            ? "bg-warning/10 border border-warning/20 text-warning"
            : "bg-error-dim border border-error/20 text-error"
        }`}>
          {gasSharePct === 100 && "Agents pay zero gas — maximum visibility. Your endpoint will be prioritized."}
          {gasSharePct > 0 && gasSharePct < 100 && `You cover ${gasSharePct}% of gas. Good, but 100% gets the most agent traffic.`}
          {gasSharePct === 0 && "No gas sponsorship — agents must pay their own gas. Most agents will skip your endpoint."}
        </div>
        {estCalls > 0 && (
          <p className="text-xs text-text-muted font-mono">
            Budget covers ~{estCalls.toLocaleString()} calls
          </p>
        )}
      </div>

      {/* ── Test Connection ── */}
      <button
        onClick={handleTest}
        disabled={testing}
        className="btn-secondary w-full font-mono"
      >
        {testing ? "Testing..." : "Test Connection"}
      </button>

      {/* ── Test Result ── */}
      {testResult && (
        <div className={`card ${testResult.ok ? "border-success bg-success-dim" : "border-error bg-error-dim"}`}>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-bold font-mono ${testResult.ok ? "text-success" : "text-error"}`}>
              {testResult.ok ? "OK" : "ERR"}
            </span>
            <div className="flex-1">
              <span className={`text-sm font-semibold font-sans ${testResult.ok ? "text-success" : "text-error"}`}>
                {testResult.ok ? "Server reachable" : "Test Failed"}
              </span>
              {testResult.errorMsg && (
                <p className="text-xs text-error mt-0.5">{testResult.errorMsg}</p>
              )}
            </div>
            <span className="text-xs text-text-muted font-mono">{testResult.latencyMs}ms</span>
          </div>
          {testResult.bodyPreview && (
            <pre className="mt-3 text-xs text-text-muted bg-bg border border-border rounded-sm p-2.5 max-h-20 overflow-auto whitespace-pre-wrap break-all font-mono">
              {testResult.bodyPreview}
            </pre>
          )}
        </div>
      )}

      {/* ── Wallet + Publish ── */}
      <div className="flex flex-col gap-3 pt-1">
        {wallet.state.connected ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            <span className="text-text-muted font-mono">
              {wallet.state.address!.slice(0, 10)}...{wallet.state.address!.slice(-4)}
            </span>
            {wrongNetwork && (
              <span className="text-error">wrong network -- click Publish to switch</span>
            )}
            <button
              onClick={wallet.disconnect}
              className="ml-auto text-text-muted hover:text-text-dim transition-colors"
            >
              disconnect
            </button>
          </div>
        ) : (
          <div className="text-xs text-text-muted font-sans">
            {wallet.state.error
              ? <span className="text-error">{wallet.state.error}</span>
              : "Connect wallet to publish on-chain"}
          </div>
        )}

        <button
          onClick={handlePublish}
          disabled={!canPublish}
          className="btn-primary w-full font-mono text-sm font-bold py-3"
        >
          {publishing
            ? (publishStep || "Publishing...")
            : !testResult?.ok
            ? "Test endpoint first"
            : !wallet.state.connected
            ? "Connect wallet + publish"
            : wrongNetwork
            ? `Switch to ${NETWORKS[selectedNet].label}`
            : backendUrl.trim()
            ? hasDeposit ? `Publish + fund ${gasDeposit} ETH + activate proxy` : "Publish + activate proxy"
            : hasDeposit ? `Publish + fund ${gasDeposit} ETH gas budget` : "Publish on-chain"
          }
        </button>

        {/* ── Publish Error ── */}
        {publishError && (
          <div className="card border-error bg-error-dim text-sm text-error">
            {publishError}
          </div>
        )}

        {/* ── Success Card ── */}
        {publishResult && (
          <div className="card border-success bg-success-dim flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="text-success text-lg font-bold font-mono">OK</span>
              <div>
                <span className="text-sm font-bold text-success font-sans">
                  {endpointName || `Endpoint #${publishResult.endpointId}`}
                </span>
                <span className="text-xs text-text-muted ml-1 font-mono">#{publishResult.endpointId}</span>
                {requireWorldId && (
                  <span className="badge-accent ml-2 text-[10px]">WorldID</span>
                )}
                <div className="text-xs text-text-muted mt-0.5">
                  {NETWORKS[publishResult.networkId].label} -- chain {NETWORKS[publishResult.networkId].chainId}
                </div>
              </div>
            </div>

            {/* On-chain details */}
            <div className="bg-bg border border-border rounded-sm p-3 flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {[
                  ["Endpoint", `#${publishResult.endpointId}`],
                  ["Price", `$${price} USD`],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span className="label text-[9px]">{k} </span>
                    <span className="text-xs text-text-dim font-mono">{v}</span>
                  </div>
                ))}
              </div>

              {/* Your API URL */}
              <div className="flex flex-col gap-1 mt-1">
                <span className="label text-[9px]">Your API URL</span>
                <code className="text-xs text-accent font-mono break-all">
                  {publicAgentGateBase()}/api/proxy/{publishResult.endpointId}
                </code>
              </div>

              <code className="text-[10px] text-accent font-mono break-all mt-1">
                Tx: {publishResult.txHash}
              </code>
              <div className="flex gap-3">
                <a
                  href={NETWORKS[publishResult.networkId].explorerTx(publishResult.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-accent hover:underline"
                >
                  View on BaseScan
                </a>
                <a
                  href={NETWORKS[publishResult.networkId].explorerAddr(DEPLOYMENTS[selectedNet].publisherRegistry)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-text-muted hover:underline"
                >
                  registry
                </a>
                <a
                  href={NETWORKS[publishResult.networkId].explorerAddr(paymasterAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-text-muted hover:underline"
                >
                  paymaster
                </a>
              </div>
            </div>

            {/* Proxy active */}
            {proxyDone && (
              <div className="bg-bg border border-success/30 rounded-sm p-3 flex flex-col gap-2">
                <div className="text-sm font-bold text-success font-sans">Proxy active</div>
                <code className="text-xs text-accent font-mono break-all bg-surface p-2 rounded-sm block">
                  {publicAgentGateBase()}{proxyDone}
                </code>
                <p className="text-xs text-text-muted font-sans">
                  Forwards to <strong className="text-text-dim">{backendUrl}</strong>. API key injected server-side.
                </p>
                <code className="text-[10px] text-text-muted font-mono break-all bg-surface p-1.5 rounded-sm">
                  curl {publicAgentGateBase()}{proxyDone}
                </code>
              </div>
            )}

            {/* Proxy error */}
            {proxyError && !proxyDone && (
              <div className="card border-error bg-error-dim text-xs text-error break-all">
                Proxy config failed: {proxyError} -- go to the Manage tab to retry.
              </div>
            )}

            {/* Gas deposit status */}
            {hasDeposit && (
              <div className={`rounded-sm p-3 flex flex-col gap-2 border ${
                depositDone
                  ? "bg-success-dim border-success/30"
                  : depositError
                  ? "bg-error-dim border-error/30"
                  : "bg-surface border-border"
              }`}>
                {depositDone ? (
                  <div className="text-sm font-bold text-success font-sans">
                    Gas budget deposited -- {gasDeposit} ETH, {gasSharePct}% sponsorship, ~{estCalls.toLocaleString()} calls
                  </div>
                ) : depositError ? (
                  <>
                    <div className="text-sm font-bold text-error font-sans">Deposit failed</div>
                    <p className="text-xs text-error break-all">{depositError}</p>
                    <p className="text-xs text-text-muted font-sans">
                      Endpoint registered but no gas budget. Wallet needs {gasDeposit} ETH + gas.
                    </p>
                    <button
                      onClick={handleRetryDeposit}
                      disabled={publishing}
                      className="btn-secondary w-full font-mono mt-1"
                    >
                      {publishing ? publishStep || "Sending..." : `Retry deposit ${gasDeposit} ETH`}
                    </button>
                  </>
                ) : (
                  <div className="text-xs text-text-muted font-sans">
                    Depositing {gasDeposit} ETH gas budget...
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
