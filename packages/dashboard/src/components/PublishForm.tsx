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
  const [contentType,     setContentType]     = useState<"webpage" | "api">("webpage");
  const [headerRows,      setHeaderRows]      = useState<{key: string; val: string}[]>([{ key: "", val: "" }]);
  const [requireWorldId,  setRequireWorldId]  = useState(false);
  const [maxConcurrent,   setMaxConcurrent]   = useState(3);
  const [paymentTimeoutSeconds, setPaymentTimeoutSeconds] = useState(60);
  // Pricing model: flat per-call (existing behavior, uses on-chain price)
  // or per-token (buyer pays up to max budget based on token counts).
  const [pricingModel, setPricingModel] = useState<"per-call" | "per-token">("per-call");
  const [pricePerMillionTokens, setPricePerMillionTokens] = useState(10);
  const [maxInputTokens,  setMaxInputTokens]  = useState(4000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(1000);
  const [proxyDone,       setProxyDone]       = useState<string | null>(null);
  const [proxyError,      setProxyError]      = useState<string | null>(null);
  const [tunnelToken,     setTunnelToken]     = useState<string | null>(null);
  const [showAdvanced,    setShowAdvanced]    = useState(false);

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
  // Two-phase check:
  //   Phase 1: is the AgentGate server itself reachable?
  //   Phase 2: is the publisher's backend URL reachable FROM the server?
  //            (the server does the HEAD, not the browser — avoids CORS)
  // Both must pass for the Test to go green and the Publish button to unlock.
  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);
    const t0 = Date.now();

    // Basic client-side URL validation first
    const trimmedBackend = backendUrl.trim();
    if (!trimmedBackend) {
      setTesting(false);
      setTestResult({
        ok: false, status: 0, statusText: "—", latencyMs: 0, contentType: null, bodyPreview: "",
        errorMsg: "Please enter your Backend URL above before testing.",
      });
      return;
    }
    try { new URL(trimmedBackend); } catch {
      setTesting(false);
      setTestResult({
        ok: false, status: 0, statusText: "—", latencyMs: 0, contentType: null, bodyPreview: "",
        errorMsg: `"${trimmedBackend}" is not a valid URL. It must start with https:// (or http:// for local dev).`,
      });
      return;
    }

    try {
      // Phase 1: AgentGate server health
      const healthRes = await fetch(healthCheckUrl(), { signal: AbortSignal.timeout(8000) });
      if (healthRes.status !== 200) {
        const latencyMs = Date.now() - t0;
        setTestResult({
          ok: false, status: healthRes.status, statusText: healthRes.statusText, latencyMs,
          contentType: null, bodyPreview: "",
          errorMsg: `AgentGate server health check failed (${healthRes.status}). Is the server running?`,
        });
        return;
      }

      // Phase 2: Ask the server to verify the backend URL is reachable.
      // We POST to the health-check-backend route which does a HEAD from the
      // server side (so we don't hit CORS issues from the browser). If the
      // server doesn't have this route, fall through with a warning.
      const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";
      let backendOk = true;
      let backendMsg = "";
      try {
        // Build auth headers sample for the test (API mode may need them)
        const testHeaders: Record<string, string> = {};
        if (contentType === "api") {
          for (const row of headerRows) {
            if (row.key.trim()) testHeaders[row.key.trim()] = row.val.trim();
          }
        }
        const backendRes = await fetch(`${SERVER}/api/publisher/test-backend`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backendUrl: trimmedBackend, injectHeaders: testHeaders }),
          signal: AbortSignal.timeout(12000),
        });
        const backendData = await backendRes.json().catch(() => ({})) as any;
        if (!backendRes.ok || backendData.error) {
          backendOk = false;
          backendMsg = backendData.error || `Backend check returned ${backendRes.status}`;
        } else {
          backendMsg = `Backend reachable (HTTP ${backendData.status}, ${backendData.latencyMs}ms)`;
        }
      } catch (backendErr: any) {
        // If the route doesn't exist yet, don't block — just warn
        if (backendErr?.name === "TimeoutError") {
          backendOk = false;
          backendMsg = "Backend URL timed out (>12s). Is your tunnel running?";
        } else {
          backendMsg = "(backend pre-check skipped — route not deployed yet)";
        }
      }

      const latencyMs = Date.now() - t0;
      const ok = backendOk;
      const bodyPreview = ok
        ? `AgentGate server OK (${publicAgentGateBase()}).\n${backendMsg}\n\nOn-chain URL: ${url.trim() || "(loading...)"}\nBackend: ${trimmedBackend}\n\nAfter publish, agents pay x402 and AgentGate forwards to your backend.`
        : "";
      setTestResult({
        ok, status: ok ? 200 : 0, statusText: ok ? "OK" : "Backend unreachable",
        latencyMs, contentType: null, bodyPreview,
        errorMsg: ok ? undefined : `Server OK but backend failed: ${backendMsg}`,
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
    // If the URL is empty, skip test requirement — the CLI will set it later.
    if (!testResult?.ok && backendUrl.trim()) return;
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }

    // GUARD: validate the backend URL format one more time before spending
    // any gas or USDC. This prevents the "published with garbage URL" bug
    // where on-chain txs succeed but the proxy-config POST fails later
    // because the backend is unreachable. The Test button already catches
    // this, but a user could change the URL after passing the test.
    const trimmedBackendUrl = backendUrl.trim();
    if (trimmedBackendUrl) {
      try { new URL(trimmedBackendUrl); } catch {
        setPublishError(`Invalid backend URL: "${trimmedBackendUrl}". Must start with https:// or http://. Fix it before publishing — on-chain transactions cost real USDC.`);
        return;
      }
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

      const priceNum = parseDecimalInput(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        throw new Error("Invalid price — use a decimal number (e.g. 0.03)");
      }
      const priceUnits = BigInt(Math.round(priceNum * 1_000_000));

      // Step 1: Approve USDC for publishing fee (1 USDC)
      const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
      const PUBLISHING_FEE = 1_000_000n; // 1 USDC (6 decimals)
      const ERC20_ABI = [
        { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
      ] as const;

      setPublishStep("1/3 Approving 1 USDC publishing fee...");
      await wallet.writeContract(
        selectedNet,
        USDC_ADDRESS,
        ERC20_ABI as any,
        "approve",
        [DEPLOYMENTS[selectedNet].publisherRegistry, PUBLISHING_FEE]
      );

      // Step 2: Register on PublisherRegistry (pays the fee)
      setPublishStep("2/3 Registering endpoint...");
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
      // Skip the deposit entirely if sponsorship is 0% — depositing ETH the
      // paymaster will never spend on the publisher's behalf is wasted money.
      const willDeposit = Number.isFinite(gasNum) && gasNum > 0 && gasSharePct > 0;
      const totalSteps = (willDeposit ? 1 : 0) + (backendUrl.trim() ? 1 : 0) + 1;
      let step = 1;

      // Step 2 (optional): Fund gas budget on the Paymaster
      if (willDeposit) {
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
          if (contentType === "api") {
            for (const row of headerRows) {
              if (row.key.trim()) injectHeaders[row.key.trim()] = row.val.trim();
            }
          }
          const timestamp = Date.now();
          const message   = `AgentGate proxy config\nendpointId: ${endpointId}\nbackendUrl: ${backendUrl.trim()}\ntimestamp: ${timestamp}`;
          const signature = await (window as any).ethereum.request({
            method: "personal_sign",
            params: [message, wallet.state.address],
          });
          // In webpage mode the endpoint name must NOT leak the backend
          // hostname — the whole pay-to-unlock model depends on the URL
          // being secret. Let the backend default to "Endpoint #N" instead.
          const publicName = contentType === "webpage" ? undefined : (endpointName || undefined);
          const res = await fetch(`${SERVER}/api/publisher/proxy-config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              endpointId, name: publicName,
              backendUrl: backendUrl.trim(),
              injectHeaders, requireWorldId,
              maxConcurrent,
              paymentTimeoutSeconds,
              contentType,
              pricingModel,
              // Only sent when pricingModel === "per-token" — the server
              // ignores these fields for "per-call" endpoints.
              pricePerMillionTokens: pricingModel === "per-token" ? pricePerMillionTokens : undefined,
              maxInputTokens:        pricingModel === "per-token" ? maxInputTokens        : undefined,
              maxOutputTokens:       pricingModel === "per-token" ? maxOutputTokens       : undefined,
              walletAddress: wallet.state.address,
              signature, timestamp,
            }),
          });
          const data = await res.json() as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setProxyDone(data.proxyUrl);
          if (data.tunnelToken) setTunnelToken(data.tunnelToken);
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
  // If backendUrl is empty the publisher plans to connect via CLI later.
  // In that case Test Connection is not required — they can publish right
  // away and get a tunnel token. The CLI will set the URL via set-tunnel.
  const urlEmpty     = !backendUrl.trim();
  const canPublish   = (testResult?.ok || urlEmpty) && !publishing && !publishResult;
  const gasDepositNum = parseDecimalInput(gasDeposit);
  // 0% sponsorship => no point depositing ETH (the paymaster covers nothing).
  const hasDeposit    = Number.isFinite(gasDepositNum) && gasDepositNum > 0 && gasSharePct > 0;

  const GAS_PER_CALL   = 65_000n;
  const costPerCallWei = gasPrice * GAS_PER_CALL;
  const depositWei     = hasDeposit ? BigInt(Math.round(gasDepositNum * 1e18)) : 0n;
  const estCalls       = costPerCallWei > 0n && depositWei > 0n ? Number(depositWei / costPerCallWei) : 0;
  const endpointName   = endpointNameFromUrl();

  return (
    <div className="flex flex-col gap-6">

      {/* ── CLI quick-start banner ── */}
      <div className="rounded-lg border border-accent/30 bg-accent-dim p-4 flex flex-col gap-2">
        <p className="text-sm text-text font-sans">
          <strong className="font-semibold">Share your local AI in one command</strong>
          <span className="text-text-muted"> — publish an endpoint below, then run:</span>
        </p>
        <code className="text-xs text-accent font-mono bg-bg border border-border rounded-sm px-3 py-2 block">
          npx @agentgate/cli tunnel --token {"<"}your-token{">"}
        </code>
        <p className="text-xs text-text-muted font-sans">
          Starts a tunnel from your machine to AgentGate. Buyers pay USDC, you earn per call. No wallet or private key needed in the terminal.
        </p>
      </div>

      {/* ── Hero text ── */}
      <div>
        <h2 className="text-lg font-semibold text-text mb-1 font-sans">Monetize any API or URL</h2>
        <p className="text-sm text-text-muted font-sans">
          Put any URL behind a paywall. AI agents pay per call, you earn USDC.
        </p>
      </div>

      {/* ── Content type toggle ── */}
      <div className="flex flex-col gap-1.5">
        <label className="label">What are you protecting?</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setContentType("webpage")}
            className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
              contentType === "webpage" ? "border-accent bg-accent-dim" : "hover:border-border-hover"
            }`}
          >
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              contentType === "webpage" ? "border-accent" : "border-border-hover"
            }`}>
              {contentType === "webpage" && <span className="w-2 h-2 rounded-full bg-accent" />}
            </span>
            <div>
              <div className="text-sm font-medium text-text font-sans">Webpage</div>
              <div className="text-xs text-text-muted font-sans mt-0.5">Blog, article, report, any public URL</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setContentType("api")}
            className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
              contentType === "api" ? "border-accent bg-accent-dim" : "hover:border-border-hover"
            }`}
          >
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              contentType === "api" ? "border-accent" : "border-border-hover"
            }`}>
              {contentType === "api" && <span className="w-2 h-2 rounded-full bg-accent" />}
            </span>
            <div>
              <div className="text-sm font-medium text-text font-sans">API</div>
              <div className="text-xs text-text-muted font-sans mt-0.5">OpenAI, Anthropic, your own API</div>
            </div>
          </button>
        </div>
      </div>

      {/* ── Backend URL ── */}
      <div className="flex flex-col gap-1.5">
        <label className="label">{contentType === "webpage" ? "Page URL" : "API Endpoint"}</label>
        <input
          type="url"
          placeholder={contentType === "webpage"
            ? "https://yourblog.com/article"
            : "https://api.openai.com/v1/chat/completions"}
          value={backendUrl}
          onChange={(e) => setBackendUrl(e.target.value)}
          className="input"
        />
        {contentType === "api" && !backendUrl.trim() && (
          <p className="text-[11px] text-text-muted font-sans">
            Leave empty if you'll connect via CLI later. You'll get a tunnel token after publishing.
          </p>
        )}
      </div>

      {/* ── Simple price input (always visible) ── */}
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
          <span className="text-sm text-text-muted font-sans">USDC per call</span>
        </div>
      </div>

      {/* ── Advanced settings toggle ── */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-2 text-xs font-mono text-text-muted hover:text-accent transition-colors self-start"
      >
        <span className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}>▸</span>
        {showAdvanced ? "Hide advanced settings" : "Advanced settings"}
        <span className="text-text-muted/40">(headers, pricing model, gas, verification)</span>
      </button>

      {/* ── ADVANCED SETTINGS (collapsed by default) ─────────────────── */}
      {showAdvanced && (<>

      {/* ── Auth Headers (only for API mode) ── */}
      {contentType === "api" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="label">
              Auth Headers
              <span className="text-text-muted/50 normal-case tracking-normal ml-1.5">
                injected server-side, never exposed to agents
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
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Pricing ── */}
      <div className="flex flex-col gap-3">
        <div>
          <label className="label">Pricing model</label>
          <p className="text-xs text-text-muted mt-1">
            Flat per call is simplest. Per token charges based on usage — buyers pay a
            maximum capped by your input+output budget, and the dashboard logs the
            delta between budgeted and actual tokens.
          </p>
        </div>

        {/* Mode radio — webpage endpoints always use flat per-call */}
        {contentType === "api" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPricingModel("per-call")}
                className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
                  pricingModel === "per-call" ? "border-accent bg-accent-dim" : "hover:border-border-hover"
                }`}
              >
                <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                  pricingModel === "per-call" ? "border-accent" : "border-border-hover"
                }`}>
                  {pricingModel === "per-call" && <span className="w-2 h-2 rounded-full bg-accent" />}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text font-sans">Flat per call</span>
                    <span className="text-[9px] text-success font-mono">AGENTS PREFER</span>
                  </div>
                  <div className="text-xs text-text-muted font-sans mt-0.5">One fixed price, same amount whether the call is short or long.</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setPricingModel("per-token")}
                className={`card flex items-start gap-3 text-left cursor-pointer transition-colors ${
                  pricingModel === "per-token" ? "border-accent bg-accent-dim" : "hover:border-border-hover"
                }`}
              >
                <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                  pricingModel === "per-token" ? "border-accent" : "border-border-hover"
                }`}>
                  {pricingModel === "per-token" && <span className="w-2 h-2 rounded-full bg-accent" />}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text font-sans">Per token</span>
                    <span className="badge-accent text-[10px]">LLM</span>
                  </div>
                  <div className="text-xs text-text-muted font-sans mt-0.5">Price scales with input+output tokens, capped at a max budget per call.</div>
                </div>
              </button>
            </div>

            {/* Pricing model trade-off cheat-sheet */}
            <div className="rounded-sm px-3 py-2 text-xs bg-bg border border-border text-text-muted leading-relaxed">
              <strong className="text-text-dim">Which should you pick?</strong>
              {" "}
              <strong className="text-success">Flat per call</strong> is simpler and typically
              looks cheaper to buyers — same low price every time, so agents that make many
              small calls flock to it. You overcharge for long conversations and undercharge
              for long ones. Use it when your workload has consistent size (short answers,
              reformatting, classification).
              {" "}
              <strong className="text-accent">Per token</strong> scales with actual work and
              protects you against abuse (someone pasting a huge document and asking a 5-word
              question). Buyers see a max-budget cap per call, which is less predictable —
              price-sensitive agents may skip your endpoint in favor of a flat-rate one. Use
              it when workload varies a lot (open-ended chat, RAG, code-gen).
            </div>
          </>
        )}

        {/* Flat price input moved to the simple form above — not duplicated here */}

        {/* Per-token budget configuration */}
        {contentType === "api" && pricingModel === "per-token" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1 flex-1">
                <label className="label text-[10px]">Price per 1M tokens (USD)</label>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted text-sm">$</span>
                  <input
                    type="number"
                    min={0.01}
                    step={0.5}
                    value={pricePerMillionTokens}
                    onChange={(e) => setPricePerMillionTokens(Math.max(0.01, Number(e.target.value) || 10))}
                    className="input w-24 text-center font-mono"
                  />
                  <span className="text-xs text-text-muted font-sans">per 1M</span>
                </div>
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <label className="label text-[10px]">Max input tokens</label>
                <input
                  type="number"
                  min={100}
                  max={32000}
                  step={100}
                  value={maxInputTokens}
                  onChange={(e) => setMaxInputTokens(Math.max(100, Math.min(32000, Number(e.target.value) || 4000)))}
                  className="input w-24 text-center font-mono"
                />
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <label className="label text-[10px]">Max output tokens</label>
                <input
                  type="number"
                  min={10}
                  max={8000}
                  step={100}
                  value={maxOutputTokens}
                  onChange={(e) => setMaxOutputTokens(Math.max(10, Math.min(8000, Number(e.target.value) || 1000)))}
                  className="input w-24 text-center font-mono"
                />
              </div>
            </div>

            {/* Live preview of the max price */}
            {(() => {
              const maxTotal = maxInputTokens + maxOutputTokens;
              const maxCost = (maxTotal / 1_000_000) * pricePerMillionTokens;
              return (
                <div className="rounded-sm px-3 py-2 text-xs bg-accent-dim border border-accent/20 text-accent font-mono">
                  Max cost per call: {maxTotal.toLocaleString()} tokens × ${pricePerMillionTokens}/1M = <strong>${maxCost.toFixed(6)}</strong>
                </div>
              );
            })()}

            <div className="rounded-sm px-3 py-2 text-xs bg-bg border border-border text-text-muted">
              <strong className="text-text-dim">How it works:</strong> the proxy estimates input
              tokens from your request body (≈ chars/4), rejects calls over{" "}
              <code className="font-mono text-text-dim">{maxInputTokens.toLocaleString()}</code>{" "}
              input tokens, injects{" "}
              <code className="font-mono text-text-dim">options.num_predict = {maxOutputTokens}</code>{" "}
              to cap the output, and bills the buyer the MAX budget above. Actual token usage
              is parsed from the response and logged for observability (future upgrade: pay
              only actual tokens via <code className="font-mono">upto</code> scheme).
            </div>
          </div>
        )}
      </div>

      {/* ── Human Verification ── */}
      <div className="flex flex-col gap-1.5">
        <div>
          <label className="label">Human Verification</label>
          <p className="text-xs text-text-muted mt-1">
            Recommended for paid APIs (OpenAI, Anthropic, etc.) — prevents bots from draining your API credits.
          </p>
        </div>
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
              <div className="text-sm font-medium text-text font-sans">Open access</div>
              <div className="text-xs text-text-muted font-sans mt-0.5">Any agent can pay and use. Best for public content, articles, open data.</div>
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
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text font-sans">Verified humans only</span>
                <span className="badge-accent text-[10px]">Recommended for APIs</span>
              </div>
              <div className="text-xs text-text-muted font-sans mt-0.5">
                Only WorldID-verified agents can access. Prevents bot abuse and protects your API key. Verified agents get 3 free calls.
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* ── Capacity & Timeouts (API mode only) ────────────────────────── */}
      {/* In webpage mode the proxy just returns a redirect to the backend  */}
      {/* URL after payment — no upstream forwarding, no x402 timeout in    */}
      {/* play (browser path uses direct USDC transfer). Hiding the section */}
      {/* keeps the publish form focused on what actually matters.          */}
      {contentType === "api" && (
        <div className="flex flex-col gap-3">
          <div>
            <label className="label">Capacity & Timeouts</label>
            <p className="text-xs text-text-muted mt-1">
              Protect your backend from being overwhelmed. Requests beyond the concurrency cap get
              rejected with HTTP 429 — <strong className="text-text-dim">before</strong> payment is
              taken, so buyers are never charged for capacity limits.
            </p>
          </div>

          {/* Max concurrent requests */}
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1 flex-1">
              <label className="label text-[10px]">Max concurrent requests</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                  className="input w-24 text-center font-mono"
                />
                <span className="text-xs text-text-muted font-sans">parallel calls</span>
              </div>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="label text-[10px]">Payment timeout (seconds)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={10}
                  max={300}
                  step={10}
                  value={paymentTimeoutSeconds}
                  onChange={(e) => setPaymentTimeoutSeconds(Math.max(10, Math.min(300, Number(e.target.value) || 60)))}
                  className="input w-24 text-center font-mono"
                />
                <span className="text-xs text-text-muted font-sans">x402 signature validity</span>
              </div>
            </div>
          </div>

          {/* Hardware hints */}
          <div className="rounded-sm px-3 py-2 text-xs bg-bg border border-border text-text-muted">
            <strong className="text-text-dim">Sizing hints:</strong>
            {" "}
            Fast APIs / OpenAI proxy → <code className="font-mono text-text-dim">max 20+, timeout 60s</code>.
            {" "}
            Local Ollama on M1/M2 → <code className="font-mono text-text-dim">max 2–3, timeout 180s</code>.
            {" "}
            Local Ollama on RTX 4090 → <code className="font-mono text-text-dim">max 6–8, timeout 120s</code>.
            {" "}
            If you're not sure, leave the defaults (3 parallel, 60s).
          </div>
        </div>
      )}

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

      </>)}
      {/* ── END ADVANCED SETTINGS ─────────────────────────────────────── */}

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
            : !testResult?.ok && backendUrl.trim()
            ? "Test endpoint first"
            : !wallet.state.connected
            ? "Connect wallet + publish"
            : wrongNetwork
            ? `Switch to ${NETWORKS[selectedNet].label}`
            : urlEmpty
            ? hasDeposit ? `Publish + fund ${gasDeposit} ETH (CLI connects later)` : "Publish on-chain (CLI connects later)"
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

            {/* CLI tunnel command — shown when we have a tunnel token */}
            {tunnelToken && (
              <div className="bg-bg border border-accent/30 rounded-sm p-3 flex flex-col gap-2">
                <div className="text-sm font-bold text-accent font-sans">Connect your local AI</div>
                <p className="text-xs text-text-muted font-sans">
                  Run this in a terminal to start a tunnel from your machine to this endpoint.
                  No wallet needed — the token authenticates you.
                </p>
                <div className="relative">
                  <code className="text-[11px] text-accent font-mono break-all bg-surface p-2 rounded-sm block pr-16">
                    npx @agentgate/cli tunnel --token {tunnelToken}
                  </code>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(`npx @agentgate/cli tunnel --token ${tunnelToken}`);
                      } catch {}
                    }}
                    className="absolute top-1.5 right-1.5 text-[10px] font-mono text-text-muted hover:text-accent transition-colors px-2 py-0.5 border border-border rounded-sm"
                  >
                    copy
                  </button>
                </div>
                <p className="text-[10px] text-text-muted/60 font-sans">
                  Save this token — it is shown only once. If you lose it, re-publish from this form to generate a new one.
                </p>
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
