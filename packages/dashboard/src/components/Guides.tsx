import { useState } from "react";

interface Props {
  onGoToPublish: () => void;
}

type Platform = "macos" | "linux" | "windows";

const INSTALL_CF: Record<Platform, string> = {
  macos: "brew install cloudflared",
  linux:
    "curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb",
  windows: "winget install --id Cloudflare.cloudflared",
};

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative bg-bg border border-border rounded-sm">
      <pre className="text-xs text-text-dim font-mono p-3 pr-16 overflow-x-auto whitespace-pre-wrap break-all">
        {children}
      </pre>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
        className="absolute top-2 right-2 text-[10px] font-mono text-text-muted hover:text-accent transition-colors px-2 py-1 border border-border rounded-sm"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

export function Guides({ onGoToPublish }: Props) {
  const [platform, setPlatform] = useState<Platform>("macos");

  return (
    <div className="flex flex-col gap-6">
      {/* ── Hero ── */}
      <div>
        <h2 className="text-lg font-semibold text-text mb-1 font-sans">
          Sell your local AI in one command
        </h2>
        <p className="text-sm text-text-muted font-sans">
          Run Ollama on your machine, publish an endpoint from the dashboard, paste one
          command in your terminal. Buyers pay USDC, you earn per call.
        </p>
      </div>

      {/* ── The command ──────────────────────────────────────────────────── */}
      <div className="card flex flex-col gap-4 border-accent/30 bg-accent-dim">
        <div className="flex items-center gap-2">
          <span className="text-accent font-mono font-bold text-sm">$</span>
          <code className="text-sm text-accent font-mono">
            npx agentgate-cli tunnel --token {"<"}your-token{">"}
          </code>
        </div>
        <p className="text-xs text-text-muted font-sans leading-relaxed">
          This single command checks Ollama is running, installs a secure tunnel
          to your machine, registers it with AgentGate, and keeps everything alive.
          No wallet or private key needed in the terminal — the token authenticates you.
        </p>
      </div>

      {/* ── 3 steps ──────────────────────────────────────────────────────── */}
      <div className="card flex flex-col gap-5">
        <h3 className="text-sm font-bold text-text font-sans">How to get started</h3>

        {/* Step 1 */}
        <div className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-accent-dim border border-accent/30 flex items-center justify-center text-xs font-mono font-bold text-accent shrink-0">
            1
          </span>
          <div className="flex flex-col gap-2 min-w-0">
            <h4 className="text-xs font-semibold text-text font-sans">
              Install Ollama + cloudflared
            </h4>
            <p className="text-xs text-text-muted font-sans">
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Download Ollama
              </a>
              {" "}and pull a model (e.g. <code className="font-mono text-text-dim">ollama pull qwen2.5:3b</code>).
              Then install cloudflared:
            </p>
            <div className="flex gap-1">
              {(["macos", "linux", "windows"] as Platform[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPlatform(p)}
                  className={`text-[11px] font-mono px-2.5 py-0.5 rounded-sm border transition-colors ${
                    platform === p
                      ? "bg-accent-dim border-accent/30 text-accent"
                      : "bg-transparent border-border text-text-muted hover:text-text-dim"
                  }`}
                >
                  {p === "macos" ? "macOS" : p === "linux" ? "Linux" : "Windows"}
                </button>
              ))}
            </div>
            <CodeBlock>{INSTALL_CF[platform]}</CodeBlock>
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-accent-dim border border-accent/30 flex items-center justify-center text-xs font-mono font-bold text-accent shrink-0">
            2
          </span>
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-text font-sans">
              Publish an endpoint
            </h4>
            <p className="text-xs text-text-muted font-sans">
              Go to the Publish tab, choose <strong className="text-text-dim">API</strong> mode,
              set your price, and leave the URL field empty. After publishing you'll see
              your <strong className="text-text-dim">tunnel token</strong> — copy it.
            </p>
            <button onClick={onGoToPublish} className="btn-primary w-fit font-mono text-xs">
              Go to Publish →
            </button>
          </div>
        </div>

        {/* Step 3 */}
        <div className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-accent-dim border border-accent/30 flex items-center justify-center text-xs font-mono font-bold text-accent shrink-0">
            3
          </span>
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-text font-sans">
              Run the CLI
            </h4>
            <p className="text-xs text-text-muted font-sans">
              Paste your token and run:
            </p>
            <CodeBlock>npx agentgate-cli tunnel --token agt_xxxxx</CodeBlock>
            <p className="text-xs text-text-muted font-sans">
              The CLI handles everything: detects Ollama, starts a tunnel with the right
              flags, registers the URL with AgentGate. Your endpoint goes live in ~10 seconds.
              Press Ctrl+C to stop.
            </p>
          </div>
        </div>
      </div>

      {/* ── Things to know ───────────────────────────────────────────────── */}
      <div className="card flex flex-col gap-2">
        <h3 className="text-xs font-bold text-text-muted font-sans uppercase tracking-wider">
          Things to know
        </h3>
        <ul className="text-xs text-text-muted font-sans leading-relaxed list-disc pl-5 flex flex-col gap-1">
          <li>
            <strong className="text-text-dim">Keep the terminal open.</strong> Closing the CLI stops the tunnel.
          </li>
          <li>
            <strong className="text-text-dim">Laptop sleep = offline.</strong> Buyers won't be charged
            for a dead endpoint (AgentGate checks before payment), but you won't earn either.
          </li>
          <li>
            <strong className="text-text-dim">Stick to small models (1B–8B).</strong> Quick tunnels
            timeout at ~100s. Large models on modest hardware risk exceeding that.
          </li>
          <li>
            <strong className="text-text-dim">Parallel requests:</strong> launch Ollama with{" "}
            <code className="font-mono text-text-dim">OLLAMA_NUM_PARALLEL=2</code> to serve
            multiple buyers at once. Match it to your "max concurrent" in Advanced settings.
          </li>
          <li>
            <strong className="text-text-dim">Tunnel URL changes on restart.</strong> Just re-run
            the CLI — it automatically updates AgentGate with the new URL.
          </li>
        </ul>
      </div>

      {/* ── Placeholder ──────────────────────────────────────────────────── */}
      <div className="card border-dashed text-center py-6">
        <p className="text-xs text-text-muted font-sans">
          More guides coming soon — Stable Diffusion, local RAG, custom APIs.
        </p>
      </div>
    </div>
  );
}
