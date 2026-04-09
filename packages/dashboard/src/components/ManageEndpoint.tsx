import { useState, useEffect, useCallback } from "react";
import { NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { useWallet } from "../hooks/useWallet";
import { PAYMASTER_ABI } from "../lib/abi";

// ── Types ────────────────────────────────────────────────────────────────────

interface ProxyStats {
  totalCalls: number;
  freeTrialCalls: number;
  paidCalls: number;
  uniqueAgents: number;
  totalRevenue: number;
  publisherRevenue: number;
  requireWorldId: boolean;
}

interface Liveness {
  currentStatus: "up" | "down" | "unknown";
  lastCheckAt: number | null;
  lastLatencyMs: number | null;
  uptimePercent: number;
  totalChecks: number;
}

interface MyEndpoint {
  id: number;
  url: string;
  pricePerCall: string;
  active: boolean;
  totalCalls: number;
  totalRevenue: string;
  registeredAt: Date;
  gasBudget: string;
  gasBudgetRaw: string;
  gasSharePct: number;
  proxyStats?: ProxyStats;
  // Capacity controls stored off-chain in proxyStore. Undefined means the
  // endpoint has no proxy config row yet (legacy / webpage-only endpoints).
  maxConcurrent?: number;
  paymentTimeoutSeconds?: number;
  liveness?: Liveness;
  inFlight?: number;
  contentType?: "webpage" | "api";
  hidden?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NET = "baseSepolia" as const;
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";

// ── Component ────────────────────────────────────────────────────────────────

export function ManageEndpoint() {
  const wallet = useWallet();

  const [myEndpoints, setMyEndpoints] = useState<MyEndpoint[]>([]);
  const [myEndpointsLoading, setMyEndpointsLoading] = useState(false);

  const [managingId, setManagingId] = useState<number | null>(null);
  const [topUpAmt, setTopUpAmt] = useState("0.005");
  const [newBps, setNewBps] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveStep, setSaveStep] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveDone, setSaveDone] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [hidingId, setHidingId] = useState<number | null>(null);
  const [hideError, setHideError] = useState<string | null>(null);

  const netData = NETWORKS[NET];
  const paymasterAddr = DEPLOYMENTS[NET].paymaster;

  // ── Fetch all endpoints for connected wallet ──────────────────────────────

  const fetchMyEndpoints = useCallback(async (address: `0x${string}`) => {
    setMyEndpointsLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/data/publisher/${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const results: MyEndpoint[] = (json.endpoints || [])
        .filter((ep: any) => ep.url)
        .map((ep: any) => ({
          id: ep.id,
          url: ep.url,
          pricePerCall: (ep.pricePerCall / 1_000_000).toFixed(4),
          active: ep.active,
          totalCalls: ep.totalCalls,
          totalRevenue: (ep.totalRevenue / 1_000_000).toFixed(4),
          registeredAt: new Date(ep.registeredAt * 1000),
          gasBudget: ep.paymaster?.balance ?? "0",
          gasBudgetRaw: ep.paymaster?.balanceRaw ?? "0",
          gasSharePct: ep.paymaster ? Math.round(ep.paymaster.gasShareBps / 100) : 0,
          proxyStats: ep.proxyStats ?? undefined,
          maxConcurrent: ep.maxConcurrent,
          paymentTimeoutSeconds: ep.paymentTimeoutSeconds,
          liveness: ep.liveness ?? undefined,
          inFlight: ep.inFlight ?? 0,
          contentType: ep.contentType,
          hidden: ep.hidden ?? false,
        }));

      setMyEndpoints(results);
    } catch (e: any) {
      console.warn("[ManageEndpoint] fetchMyEndpoints failed:", e.message);
    } finally {
      setMyEndpointsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (wallet.state.connected && wallet.state.address) {
      fetchMyEndpoints(wallet.state.address);
    } else {
      setMyEndpoints([]);
    }
  }, [wallet.state.connected, wallet.state.address, fetchMyEndpoints]);

  // ── Hide / unhide an endpoint ─────────────────────────────────────────────
  async function toggleHidden(ep: MyEndpoint) {
    if (!wallet.state.address) return;
    const action = ep.hidden ? "unhide" : "hide";
    if (action === "hide") {
      const ok = window.confirm(
        `Hide endpoint #${ep.id} from your Manage list and the public Dashboard?\n\n` +
        `This does NOT deactivate the endpoint on-chain. Buyers who already have the ` +
        `URL can still pay and use it. You can un-hide from the "Show hidden" toggle.`
      );
      if (!ok) return;
    }
    setHidingId(ep.id);
    setHideError(null);
    try {
      const timestamp = Date.now();
      const message = `AgentGate ${action} endpoint\nendpointId: ${ep.id}\ntimestamp: ${timestamp}`;
      const signature = await (window as any).ethereum.request({
        method: "personal_sign",
        params: [message, wallet.state.address],
      });
      const res = await fetch(`${SERVER_URL}/api/publisher/proxy-config/${ep.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet.state.address,
          signature,
          timestamp,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Refetch so UI reflects new hidden state.
      await fetchMyEndpoints(wallet.state.address);
    } catch (e: any) {
      setHideError(e?.shortMessage || e?.message || String(e));
    } finally {
      setHidingId(null);
    }
  }

  // ── Open / close management ───────────────────────────────────────────────

  function openManage(ep: MyEndpoint) {
    setManagingId(ep.id);
    setNewBps(ep.gasSharePct * 100);
    setTopUpAmt("0.005");
    setSaveDone(null);
    setSaveError(null);
  }

  function closeManage() {
    setManagingId(null);
    setSaveDone(null);
    setSaveError(null);
  }

  // ── Save changes (top-up or share-only) ───────────────────────────────────

  async function handleSave(ep: MyEndpoint, mode: "topup" | "shareOnly") {
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== netData.chainId) {
      await wallet.switchNetwork(NET); return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveDone(null);

    try {
      let txHash: string;

      if (mode === "topup") {
        setSaveStep("Sending deposit + updating gas share...");
        const wei = BigInt(Math.round(parseFloat(topUpAmt) * 1e18));
        txHash = await wallet.writeContract(
          NET, paymasterAddr, PAYMASTER_ABI as any,
          "fundAndSetGasShare", [ep.url, newBps], wei
        );
      } else {
        setSaveStep("Updating gas share percentage...");
        txHash = await wallet.writeContract(
          NET, paymasterAddr, PAYMASTER_ABI as any,
          "setGasShare", [ep.url, newBps]
        );
      }

      setSaveDone(txHash);
      setTimeout(() => {
        if (wallet.state.address) fetchMyEndpoints(wallet.state.address);
      }, 2000);
    } catch (e: any) {
      setSaveError(e.shortMessage || e.message || String(e));
    } finally {
      setSaving(false);
      setSaveStep("");
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const wrongNetwork = wallet.state.connected && wallet.state.chainId !== netData.chainId;
  const gasSharePct = Math.round(newBps / 100);
  const topUpFloat = parseFloat(topUpAmt) || 0;

  // Visible list respects the "show hidden" toggle. Totals below are
  // computed over ALL owned endpoints regardless of hidden state so the
  // publisher still sees the real aggregate numbers.
  const visibleEndpoints = showHidden
    ? myEndpoints
    : myEndpoints.filter(e => !e.hidden);
  const hiddenCount = myEndpoints.filter(e => e.hidden).length;

  // Aggregate from proxyStats — the on-chain registry counters (e.totalCalls /
  // e.totalRevenue) are never updated by the proxy x402 path, so they're
  // always 0. proxyStats is the real source of truth for paid traffic.
  const totalCalls = myEndpoints.reduce((s, e) => s + (e.proxyStats?.totalCalls ?? 0), 0);
  const totalRevenue = myEndpoints.reduce((s, e) => s + (e.proxyStats?.totalRevenue ?? 0), 0);

  // ── Render: Not connected ─────────────────────────────────────────────────

  if (!wallet.state.connected) {
    return (
      <div className="flex flex-col items-center gap-6 py-16">
        <div className="w-14 h-14 rounded-xl bg-surface border border-border flex items-center justify-center">
          <svg className="w-7 h-7 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 6v3" />
          </svg>
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-text mb-1">Manage Your Endpoints</h2>
          <p className="text-sm text-text-muted max-w-sm">
            Connect your wallet to view your published endpoints, top up gas budgets, and track usage.
          </p>
        </div>
        <button onClick={wallet.connect} className="btn-primary px-6">
          Connect Wallet
        </button>
        {wallet.state.error && (
          <p className="text-xs text-error">{wallet.state.error}</p>
        )}
      </div>
    );
  }

  // ── Render: Connected ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-xs font-mono text-text-muted">
            {wallet.state.address!.slice(0, 10)}...{wallet.state.address!.slice(-4)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {myEndpoints.length > 0 && (
            <span className="text-xs text-text-muted">
              {visibleEndpoints.length}{showHidden ? "" : ` / ${myEndpoints.length}`} endpoint{visibleEndpoints.length !== 1 ? "s" : ""}
            </span>
          )}
          {hiddenCount > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-text-muted font-sans cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="accent-accent cursor-pointer"
              />
              Show hidden ({hiddenCount})
            </label>
          )}
          <button
            onClick={() => wallet.state.address && fetchMyEndpoints(wallet.state.address)}
            disabled={myEndpointsLoading}
            className="btn-secondary px-2 py-1 text-xs"
          >
            {myEndpointsLoading ? "..." : "refresh"}
          </button>
          <button
            onClick={wallet.disconnect}
            className="text-xs text-text-muted hover:text-text transition-colors"
          >
            disconnect
          </button>
        </div>
      </div>

      {/* Hide/unhide error */}
      {hideError && (
        <div className="card border-error bg-error-dim text-xs text-error">
          Failed to toggle hidden state: {hideError}
        </div>
      )}

      {/* Loading / empty state */}
      {myEndpointsLoading && myEndpoints.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-6">Fetching your endpoints...</p>
      ) : myEndpoints.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-text-muted">No endpoints published yet — use the Publish tab to register one.</p>
        </div>
      ) : (
        <>
          {/* Summary row */}
          <div className="card flex divide-x divide-border p-0 overflow-hidden">
            {[
              ["Total Calls", totalCalls.toString()],
              ["Total Revenue", `$${totalRevenue.toFixed(4)}`],
              ["Endpoints", myEndpoints.length.toString()],
            ].map(([label, value]) => (
              <div key={label} className="flex-1 flex flex-col gap-1 px-4 py-3">
                <span className="label">{label}</span>
                <span className="text-base font-bold font-mono text-text">{value}</span>
              </div>
            ))}
          </div>

          {/* Endpoint cards */}
          {visibleEndpoints.map((ep) => {
            const isManaging = managingId === ep.id;
            const shareChanged = isManaging && newBps !== ep.gasSharePct * 100;

            return (
              <div
                key={ep.id}
                className={`card transition-colors duration-200 ${isManaging ? "border-accent/30" : ""}`}
              >
                {/* Top row: status + URL + manage button */}
                <div className="flex items-start gap-2">
                  {(() => {
                    const status = ep.liveness?.currentStatus ?? "unknown";
                    const cls =
                      !ep.active ? "bg-text-muted" :
                      status === "up" ? "bg-success" :
                      status === "down" ? "bg-error" :
                      "bg-border-hover";
                    const title =
                      !ep.active ? "Inactive on-chain" :
                      status === "up" ? `Up · ${ep.liveness?.lastLatencyMs ?? "—"}ms · ${ep.liveness?.uptimePercent}% uptime` :
                      status === "down" ? "Down — liveness probe failed" :
                      "No liveness data yet";
                    return <span title={title} className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />;
                  })()}
                  <span className="text-sm text-text-dim font-mono break-all leading-relaxed flex-1">
                    {ep.url}
                    {ep.hidden && (
                      <span className="ml-2 text-[10px] font-sans text-text-muted italic">
                        (hidden)
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => toggleHidden(ep)}
                    disabled={hidingId === ep.id}
                    title={ep.hidden
                      ? "Un-hide this endpoint (will appear in Manage + public Dashboard again)"
                      : "Hide this endpoint from Manage and the public Dashboard"}
                    className="shrink-0 text-xs font-mono px-2 py-1 rounded-sm border bg-transparent text-text-muted border-border hover:text-warning hover:border-warning/30 transition-all duration-150 disabled:opacity-50"
                  >
                    {hidingId === ep.id ? "..." : ep.hidden ? "Unhide" : "Hide"}
                  </button>
                  <button
                    onClick={() => isManaging ? closeManage() : openManage(ep)}
                    className={`shrink-0 text-xs font-mono px-3 py-1 rounded-sm border transition-all duration-150 ${
                      isManaging
                        ? "bg-accent-dim text-accent border-accent/30"
                        : "bg-transparent text-text-muted border-border hover:text-accent hover:border-accent/30"
                    }`}
                  >
                    {isManaging ? "Close" : "Manage"}
                  </button>
                </div>

                {/* Stats row — hide in-flight/timeout for webpages where they don't apply */}
                {(() => {
                  const isWebpage = ep.contentType === "webpage";
                  const entries: [string, string][] = [
                    ["price", `$${ep.pricePerCall}/call`],
                    ["mode", isWebpage ? "webpage" : "api"],
                    ["calls", (ep.proxyStats?.totalCalls ?? 0).toString()],
                    ["revenue", `$${(ep.proxyStats?.totalRevenue ?? 0).toFixed(4)}`],
                    ["uptime", ep.liveness && ep.liveness.totalChecks > 0 ? `${ep.liveness.uptimePercent}%` : "---"],
                  ];
                  if (!isWebpage) {
                    entries.push(["in-flight", ep.maxConcurrent !== undefined ? `${ep.inFlight ?? 0}/${ep.maxConcurrent}` : "---"]);
                    entries.push(["timeout", ep.paymentTimeoutSeconds !== undefined ? `${ep.paymentTimeoutSeconds}s` : "---"]);
                  }
                  entries.push(["gas", ep.gasBudget !== "0" ? `${ep.gasBudget} ETH` : "---"]);
                  entries.push(["sponsored", ep.gasSharePct > 0 ? `${ep.gasSharePct}%` : "---"]);
                  entries.push(["since", ep.registeredAt.toLocaleDateString()]);
                  return (
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3">
                      {entries.map(([k, v]) => (
                        <div key={k} className="flex items-baseline gap-1.5">
                          <span className="label text-[10px]">{k}</span>
                          <span className="text-xs font-mono text-text-dim">{v}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Proxy stats badge row */}
                {ep.proxyStats && (ep.proxyStats.totalCalls > 0 || ep.proxyStats.requireWorldId) && (
                  <div className="flex flex-wrap items-center gap-2 mt-3 px-3 py-2 rounded-sm bg-bg border border-border">
                    {ep.proxyStats.requireWorldId && (
                      <span className="badge-accent text-[10px]">WorldID</span>
                    )}
                    {[
                      ["proxy calls", ep.proxyStats.totalCalls],
                      ["free-trial", ep.proxyStats.freeTrialCalls],
                      ["paid", ep.proxyStats.paidCalls],
                      ["agents", ep.proxyStats.uniqueAgents],
                    ].map(([k, v]) => (
                      <div key={k as string} className="flex items-baseline gap-1">
                        <span className="text-[9px] text-text-muted">{k}</span>
                        <span className="text-[10px] font-mono font-semibold text-text-dim">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Expanded management panel ─────────────────────────────── */}
                {isManaging && (
                  <div className="flex flex-col gap-4 mt-4 pt-4 border-t border-border">
                    {/* Gas share slider */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <span className="label min-w-[80px]">Gas Share</span>
                        <input
                          type="range"
                          min={0} max={100} step={5}
                          value={gasSharePct}
                          onChange={(e) => setNewBps(Number(e.target.value) * 100)}
                          className="flex-1 cursor-pointer accent-accent"
                        />
                        <span
                          className={`min-w-[48px] text-center font-mono text-base font-bold ${
                            gasSharePct >= 75 ? "text-success"
                            : gasSharePct >= 40 ? "text-accent"
                            : "text-error"
                          }`}
                        >
                          {gasSharePct}%
                        </span>
                      </div>
                      <div className="flex justify-between text-[9px] text-text-muted">
                        <span>agent pays all gas</span>
                        <span>you pay all gas</span>
                      </div>
                      {shareChanged && (
                        <p className="text-xs text-warning">
                          Change from {ep.gasSharePct}% to {gasSharePct}% (not saved yet)
                        </p>
                      )}
                    </div>

                    {/* Share-only save */}
                    {shareChanged && (
                      <button
                        onClick={() => handleSave(ep, "shareOnly")}
                        disabled={saving}
                        className="btn-secondary w-full"
                      >
                        {saving && saveStep
                          ? saveStep
                          : wrongNetwork
                          ? `Switch to ${netData.label}`
                          : `Update share to ${gasSharePct}% (no top-up)`}
                      </button>
                    )}

                    {/* Top-up section */}
                    <div className="flex flex-col gap-1.5">
                      <span className="label">Deposit amount</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={topUpAmt}
                          onChange={(e) => setTopUpAmt(e.target.value)}
                          className="input w-36"
                        />
                        <span className="text-sm text-text-muted font-sans">ETH</span>
                      </div>
                    </div>

                    <p className="text-xs text-text-muted leading-relaxed">
                      Adds {topUpAmt || "0"} ETH to your gas budget and saves the {gasSharePct}% gas share in one transaction.
                    </p>

                    <button
                      onClick={() => handleSave(ep, "topup")}
                      disabled={saving || topUpFloat <= 0}
                      className={`w-full py-2.5 text-sm font-medium font-mono rounded-sm border transition-all duration-150 ${
                        topUpFloat > 0 || wrongNetwork
                          ? "bg-success-dim text-success border-success/30 hover:bg-success/20"
                          : "bg-surface text-text-muted border-border cursor-not-allowed"
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {saving && saveStep
                        ? saveStep
                        : wrongNetwork
                        ? `Switch to ${netData.label}`
                        : topUpFloat <= 0
                        ? "Enter an amount"
                        : `Deposit ${topUpAmt} ETH + set ${gasSharePct}% share`}
                    </button>

                    {/* Success */}
                    {saveDone && (
                      <div className="flex flex-col gap-1 p-3 rounded-sm bg-success-dim border border-success/20">
                        <span className="text-sm font-semibold text-success">Saved on-chain</span>
                        <a
                          href={netData.explorerTx(saveDone)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent hover:underline"
                        >
                          View transaction
                        </a>
                      </div>
                    )}

                    {/* Error */}
                    {saveError && (
                      <div className="p-3 rounded-sm bg-error-dim border border-error/20 text-xs text-error break-all">
                        {saveError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
