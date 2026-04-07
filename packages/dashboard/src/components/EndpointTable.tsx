import { EndpointData } from "../hooks/useOnChainData";

interface Props {
  endpoints: EndpointData[];
  loading: boolean;
}

export function EndpointTable({ endpoints, loading }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="label">Registered Endpoints</span>
        <span className="text-xs font-bold text-accent font-mono">
          {loading ? "..." : endpoints.length} endpoint{endpoints.length !== 1 ? "s" : ""}
        </span>
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

      {/* Table */}
      {!loading && endpoints.length > 0 && (
        <div className="flex flex-col gap-0 border border-border rounded-lg overflow-hidden">
          {/* Column headers */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-2 bg-surface-raised border-b border-border text-[10px] text-text-muted uppercase tracking-wider font-medium">
            <span className="w-2" />
            <span>Endpoint</span>
            <span>Price</span>
            <span>Calls</span>
            <span>Revenue</span>
            <span />
          </div>

          {/* Rows */}
          {endpoints.map((ep) => (
            <div
              key={ep.id}
              className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-border last:border-b-0 hover:bg-surface-hover transition-colors"
            >
              {/* Status dot */}
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  ep.active ? "bg-success" : "bg-border-hover"
                }`}
                title={ep.active ? "Active" : "Inactive"}
              />

              {/* Name / URL */}
              <div className="min-w-0">
                {ep.proxyName && (
                  <div className="text-xs font-semibold text-text truncate">{ep.proxyName}</div>
                )}
                <div className="text-xs text-text-dim font-mono truncate">{ep.url}</div>
              </div>

              {/* Price */}
              <span className="text-xs text-text-dim font-mono whitespace-nowrap">
                ${ep.pricePerCall}
              </span>

              {/* Calls */}
              <span className="text-xs text-text-dim font-mono">
                {ep.totalCalls}
              </span>

              {/* Revenue */}
              <span className="text-xs text-text-dim font-mono whitespace-nowrap">
                ${ep.totalRevenue}
              </span>

              {/* WorldID badge */}
              <span>
                {ep.requireWorldId && (
                  <span className="badge-accent text-[9px]">WorldID</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
