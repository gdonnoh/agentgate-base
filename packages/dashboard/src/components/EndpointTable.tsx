import { useMemo, useState } from "react";
import { EndpointData } from "../hooks/useOnChainData";

interface Props {
  endpoints: EndpointData[];
  loading: boolean;
}

type Preset = "all" | "ready" | "busy" | "popular" | "reliable";

const PRESETS: { id: Preset; label: string; hint: string }[] = [
  { id: "ready",    label: "Ready",    hint: "Up + free slots" },
  { id: "busy",     label: "Busy",     hint: "At or near capacity" },
  { id: "popular",  label: "Popular",  hint: "Most paid calls" },
  { id: "reliable", label: "Reliable", hint: "Highest uptime" },
  { id: "all",      label: "All",      hint: "No filter" },
];

function isWebpage(ep: EndpointData): boolean {
  return ep.contentType === "webpage";
}

function isOffline(ep: EndpointData): boolean {
  // On-chain inactive OR liveness probe says down.
  if (!ep.active) return true;
  if (ep.liveness?.currentStatus === "down") return true;
  return false;
}

function isReady(ep: EndpointData): boolean {
  if (isOffline(ep)) return false;
  if (ep.liveness?.currentStatus !== "up") return false;
  // Webpage endpoints don't have real concurrency — if they're up, they're
  // ready. Only API endpoints can "run out of slots".
  if (isWebpage(ep)) return true;
  const cap = ep.maxConcurrent ?? 1;
  const cur = ep.inFlight ?? 0;
  return cur < cap;
}

function isBusy(ep: EndpointData): boolean {
  if (isOffline(ep)) return false;
  // A webpage can never be "busy" — it just redirects, no upstream to saturate.
  if (isWebpage(ep)) return false;
  const cap = ep.maxConcurrent ?? 1;
  const cur = ep.inFlight ?? 0;
  // "Busy" = at least half-loaded, or fully saturated
  return cur > 0 && cur / cap >= 0.5;
}

function applyPreset(list: EndpointData[], preset: Preset): EndpointData[] {
  switch (preset) {
    case "ready":
      return list.filter(isReady);
    case "busy":
      return list.filter(isBusy).sort((a, b) => {
        const au = (a.inFlight ?? 0) / (a.maxConcurrent ?? 1);
        const bu = (b.inFlight ?? 0) / (b.maxConcurrent ?? 1);
        return bu - au;
      });
    case "popular":
      return list.slice().sort((a, b) => {
        const ac = a.proxyStats?.totalCalls ?? 0;
        const bc = b.proxyStats?.totalCalls ?? 0;
        return bc - ac;
      });
    case "reliable":
      return list.slice().sort((a, b) => {
        const au = a.liveness?.uptimePercent ?? -1;
        const bu = b.liveness?.uptimePercent ?? -1;
        if (bu !== au) return bu - au;
        const al = a.liveness?.avgLatencyMs ?? Infinity;
        const bl = b.liveness?.avgLatencyMs ?? Infinity;
        return al - bl;
      });
    case "all":
    default:
      return list;
  }
}

function LivenessDot({ ep }: { ep: EndpointData }) {
  const status = ep.liveness?.currentStatus ?? "unknown";
  const colorClass =
    status === "up" ? "bg-success" :
    status === "down" ? "bg-error" :
    "bg-border-hover"; // unknown
  const title =
    status === "up"   ? `Up · ${ep.liveness?.lastLatencyMs ?? "—"}ms` :
    status === "down" ? "Down — liveness probe failed" :
                        "No liveness data yet";
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colorClass}`} title={title} />;
}

function UtilizationBadge({ ep }: { ep: EndpointData }) {
  // Webpage endpoints have no upstream forwarding, so slots are meaningless.
  // Show a simple "link" pill instead of a fake utilization number.
  if (isWebpage(ep)) {
    return (
      <span
        className="text-[9px] font-mono px-1.5 py-0.5 rounded-sm border bg-surface border-border text-text-muted whitespace-nowrap"
        title="Webpage endpoint — pay-to-unlock URL, no concurrency limits"
      >
        link
      </span>
    );
  }
  const cap = ep.maxConcurrent ?? 1;
  const cur = ep.inFlight ?? 0;
  if (cap === 0) return null;
  const ratio = cur / cap;
  let cls = "bg-surface border-border text-text-muted";
  let label = "idle";
  if (cur === 0) {
    cls = "bg-success-dim border-success/30 text-success";
    label = "idle";
  } else if (ratio >= 1) {
    cls = "bg-error-dim border-error/30 text-error";
    label = "full";
  } else if (ratio >= 0.5) {
    cls = "bg-warning/10 border-warning/20 text-warning";
    label = "busy";
  } else {
    cls = "bg-accent-dim border-accent/30 text-accent";
    label = "open";
  }
  return (
    <span
      className={`text-[9px] font-mono px-1.5 py-0.5 rounded-sm border ${cls} whitespace-nowrap`}
      title={`${cur} in-flight / ${cap} max concurrent`}
    >
      {cur}/{cap} {label}
    </span>
  );
}

function ConfidenceBadge({ ep }: { ep: EndpointData }) {
  const pct = ep.liveness?.uptimePercent;
  const checks = ep.liveness?.totalChecks ?? 0;
  if (checks === 0) {
    return (
      <span className="text-[9px] font-mono text-text-muted" title="No checks yet">—</span>
    );
  }
  const color =
    (pct ?? 0) >= 99 ? "text-success" :
    (pct ?? 0) >= 95 ? "text-accent"  :
    (pct ?? 0) >= 80 ? "text-warning" :
                       "text-error";
  return (
    <span
      className={`text-[9px] font-mono ${color}`}
      title={`${pct}% over last ${checks} checks`}
    >
      {pct}%
    </span>
  );
}

export function EndpointTable({ endpoints, loading }: Props) {
  const [preset, setPreset] = useState<Preset>("ready");
  const [hideOffline, setHideOffline] = useState(true);

  const filtered = useMemo(() => {
    let list = endpoints;
    if (hideOffline) list = list.filter(ep => !isOffline(ep));
    return applyPreset(list, preset);
  }, [endpoints, preset, hideOffline]);

  const hiddenOfflineCount = useMemo(
    () => (hideOffline ? endpoints.filter(isOffline).length : 0),
    [endpoints, hideOffline],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="label">Registered Endpoints</span>
        <span className="text-xs font-bold text-accent font-mono">
          {loading ? "..." : `${filtered.length} / ${endpoints.length}`}
        </span>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            title={p.hint}
            className={`text-[11px] font-mono px-2.5 py-1 rounded-sm border transition-colors ${
              preset === p.id
                ? "bg-accent-dim border-accent/30 text-accent"
                : "bg-transparent border-border text-text-muted hover:text-text-dim hover:border-border-hover"
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] text-text-muted font-sans cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideOffline}
            onChange={(e) => setHideOffline(e.target.checked)}
            className="accent-accent cursor-pointer"
          />
          Hide offline
          {hiddenOfflineCount > 0 && (
            <span className="text-text-muted/60">({hiddenOfflineCount})</span>
          )}
        </label>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-border" />
                <div className="h-3 bg-border rounded flex-1 max-w-[200px]" />
                <div className="h-3 bg-border rounded w-16 ml-auto" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && endpoints.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-sm text-text-muted font-sans">
            No endpoints yet. Publish your first API endpoint.
          </p>
        </div>
      )}

      {!loading && endpoints.length > 0 && filtered.length === 0 && (
        <div className="card text-center py-6">
          <p className="text-xs text-text-muted font-sans">
            No endpoints match this filter.
            {hideOffline && hiddenOfflineCount > 0 && (
              <> Try unchecking "Hide offline" or choosing a different preset.</>
            )}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="flex flex-col gap-0 border border-border rounded-lg overflow-hidden">
          {/* Column headers */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] gap-4 items-center px-4 py-2 bg-surface-raised border-b border-border text-[10px] text-text-muted uppercase tracking-wider font-medium">
            <span className="w-2" />
            <span>Endpoint</span>
            <span>Price</span>
            <span>Calls</span>
            <span>Uptime</span>
            <span>Slots</span>
            <span />
          </div>

          {/* Rows */}
          {filtered.map((ep) => {
            const paidCalls = ep.proxyStats?.totalCalls ?? 0;
            const isPerToken = ep.pricingModel === "per-token";
            // For per-token endpoints, compute the max price from the budget
            // rather than showing the on-chain price (which is a placeholder).
            const maxPerTokenCost = isPerToken && ep.pricePerMillionTokens && ep.maxInputTokens && ep.maxOutputTokens
              ? (((ep.maxInputTokens + ep.maxOutputTokens) / 1_000_000) * ep.pricePerMillionTokens).toFixed(6)
              : null;
            return (
              <div
                key={ep.id}
                className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-border last:border-b-0 hover:bg-surface-hover transition-colors"
              >
                {/* Liveness dot (replaces the on-chain active dot) */}
                <LivenessDot ep={ep} />

                {/* Name / URL — proxyName is redacted for public view, fall
                    back to a neutral label so we never accidentally expose
                    a backend hostname in the first line. */}
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text truncate flex items-center gap-1.5">
                    {ep.proxyName || `Endpoint #${ep.id}`}
                    {isPerToken && (
                      <span className="badge-accent text-[9px] shrink-0">per-token</span>
                    )}
                  </div>
                  <div className="text-xs text-text-dim font-mono truncate">{ep.url}</div>
                </div>

                {/* Price — flat for per-call, "up to $X" for per-token */}
                <span
                  className="text-xs text-text-dim font-mono whitespace-nowrap"
                  title={isPerToken
                    ? `$${ep.pricePerMillionTokens}/1M tokens × max ${(ep.maxInputTokens ?? 0) + (ep.maxOutputTokens ?? 0)} = max cost`
                    : undefined}
                >
                  {isPerToken && maxPerTokenCost ? `≤$${maxPerTokenCost}` : `$${ep.pricePerCall}`}
                </span>

                {/* Paid calls (from proxyStats, not on-chain which is 0) */}
                <span className="text-xs text-text-dim font-mono">
                  {paidCalls}
                </span>

                {/* Uptime / confidence */}
                <ConfidenceBadge ep={ep} />

                {/* Current utilization */}
                <UtilizationBadge ep={ep} />

                {/* WorldID badge */}
                <span>
                  {ep.requireWorldId && (
                    <span className="badge-accent text-[9px]">WorldID</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
