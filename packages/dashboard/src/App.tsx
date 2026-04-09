import { useState } from "react";
import { useOnChainData } from "./hooks/useOnChainData";
import { EndpointTable } from "./components/EndpointTable";
import { PublishForm } from "./components/PublishForm";
import { ManageEndpoint } from "./components/ManageEndpoint";
import { Guides } from "./components/Guides";

type View = "publish" | "dashboard" | "manage" | "guides";

export default function App() {
  const [view, setView] = useState<View>("publish");
  const { data, refetch } = useOnChainData();

  const navItems: { id: View; label: string }[] = [
    { id: "publish", label: "Publish" },
    { id: "dashboard", label: "Dashboard" },
    { id: "manage", label: "Manage" },
    { id: "guides", label: "Guides" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-text tracking-tight">AgentGate</h1>
            <span className="text-xs text-text-muted font-mono bg-surface px-2 py-0.5 rounded-sm border border-border">
              Base Sepolia
            </span>
          </div>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${
                  view === item.id
                    ? "bg-surface text-text font-medium"
                    : "text-text-muted hover:text-text-dim"
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              onClick={refetch}
              className="ml-3 p-1.5 text-text-muted hover:text-text-dim rounded-sm hover:bg-surface transition-colors"
              title="Refresh data"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-6 py-8">
        <div className="max-w-6xl mx-auto">
          {view === "publish" && <PublishForm />}
          {view === "dashboard" && (
            <div className="space-y-6">
              {/* Stats row */}
              <div className="grid grid-cols-3 gap-4">
                <div className="card">
                  <p className="label">Active Endpoints</p>
                  <p className="stat-value mt-1">{data.endpoints.filter(e => e.active).length}</p>
                </div>
                <div className="card">
                  <p className="label">Total API Calls</p>
                  <p className="stat-value mt-1">{data.totalCalls}</p>
                </div>
                <div className="card">
                  <p className="label">Gas Sponsored</p>
                  <p className="stat-value mt-1">{data.totalSponsored} <span className="text-sm text-text-muted">ETH</span></p>
                </div>
              </div>
              <EndpointTable endpoints={data.endpoints} loading={data.loading} />
            </div>
          )}
          {view === "manage" && <ManageEndpoint />}
          {view === "guides" && <Guides onGoToPublish={() => setView("publish")} />}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-xs text-text-muted">
          <span>AgentGate</span>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            <span>Base Sepolia</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
