import { useState } from "react";

interface Props {
  onGoToPublish: () => void;
}

type Platform = "macos" | "linux" | "windows";

const INSTALL_COMMANDS: Record<Platform, string> = {
  macos: "brew install cloudflared",
  linux:
    "curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb",
  windows:
    "winget install --id Cloudflare.cloudflared",
};

const TUNNEL_COMMAND = "cloudflared tunnel --url http://localhost:11434";

/** Small inline "copy to clipboard" button used inside code blocks. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — silent */
        }
      }}
      className="text-[10px] font-mono text-text-muted hover:text-accent transition-colors px-2 py-1 border border-border rounded-sm"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** Code block with a copy button in the top-right corner. */
function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative bg-bg border border-border rounded-sm">
      <pre className="text-xs text-text-dim font-mono p-3 pr-16 overflow-x-auto whitespace-pre-wrap break-all">
        {children}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={children} />
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="w-6 h-6 rounded-full bg-accent-dim border border-accent/30 flex items-center justify-center text-xs font-mono font-bold text-accent">
          {n}
        </span>
        <h4 className="text-sm font-semibold text-text font-sans">{title}</h4>
      </div>
      <div className="ml-9 flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function Guides({ onGoToPublish }: Props) {
  const [platform, setPlatform] = useState<Platform>("macos");

  return (
    <div className="flex flex-col gap-6">
      {/* ── Hero ── */}
      <div>
        <h2 className="text-lg font-semibold text-text mb-1 font-sans">Guides</h2>
        <p className="text-sm text-text-muted font-sans">
          Step-by-step setups for publishing common workloads on AgentGate.
        </p>
      </div>

      {/* ── Guide: Sell local Ollama ───────────────────────────────────────── */}
      <div className="card flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-text font-sans">
              Sell your local Ollama (or any local API)
            </h3>
            <p className="text-xs text-text-muted mt-1 font-sans">
              Expose your home PC's Ollama to the internet and monetize each call in USDC.
              No server, no domain, no paid tunnel service.
            </p>
          </div>
          <span className="badge-accent text-[10px] shrink-0">Local → public</span>
        </div>

        {/* Why this is needed */}
        <div className="text-xs text-text-muted font-sans leading-relaxed bg-bg border border-border rounded-sm p-3">
          Ollama runs on <code className="font-mono text-text-dim">localhost:11434</code> — unreachable
          from the internet because of your router's NAT. You need a tunnel that gives your local
          service a public HTTPS URL. We use <strong className="text-text-dim">Cloudflare Tunnel</strong>{" "}
          because it's free, requires no account, and works through any NAT.
        </div>

        {/* Step 1: install cloudflared */}
        <Step n={1} title="Install cloudflared">
          <div className="flex gap-1">
            {(["macos", "linux", "windows"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`text-xs font-mono px-3 py-1 rounded-sm border transition-colors ${
                  platform === p
                    ? "bg-accent-dim border-accent/30 text-accent"
                    : "bg-transparent border-border text-text-muted hover:text-text-dim"
                }`}
              >
                {p === "macos" ? "macOS" : p === "linux" ? "Linux" : "Windows"}
              </button>
            ))}
          </div>
          <CodeBlock>{INSTALL_COMMANDS[platform]}</CodeBlock>
          <p className="text-[11px] text-text-muted font-sans">
            Alternative downloads:{" "}
            <a
              href="https://github.com/cloudflare/cloudflared/releases/latest"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              GitHub releases
            </a>
            .
          </p>
        </Step>

        {/* Step 2: start Ollama */}
        <Step n={2} title="Make sure Ollama is running">
          <p className="text-xs text-text-muted font-sans">
            Open a terminal and run a model. AgentGate will forward paid requests to whatever is
            listening on port <code className="font-mono text-text-dim">11434</code>.
          </p>
          <CodeBlock>ollama run llama3</CodeBlock>
        </Step>

        {/* Step 3: open the tunnel */}
        <Step n={3} title="Open the tunnel">
          <p className="text-xs text-text-muted font-sans">
            In a <strong className="text-text-dim">second terminal</strong>, run:
          </p>
          <CodeBlock>{TUNNEL_COMMAND}</CodeBlock>
          <p className="text-xs text-text-muted font-sans">
            The output will include a line like:
          </p>
          <CodeBlock>https://random-words-1234.trycloudflare.com</CodeBlock>
          <p className="text-xs text-text-muted font-sans">
            That's your <strong className="text-text-dim">public Ollama URL</strong>. Copy it.
          </p>
        </Step>

        {/* Step 4: publish */}
        <Step n={4} title="Publish on AgentGate">
          <p className="text-xs text-text-muted font-sans">
            Go to the Publish tab, choose <strong className="text-text-dim">API</strong> mode, paste
            the tunnel URL (append <code className="font-mono text-text-dim">/api/generate</code>{" "}
            or <code className="font-mono text-text-dim">/api/chat</code> depending on the Ollama
            endpoint you want to sell), set your price per call, and click Publish.
          </p>
          <CodeBlock>https://random-words-1234.trycloudflare.com/api/chat</CodeBlock>
          <button onClick={onGoToPublish} className="btn-primary w-fit font-mono text-xs mt-1">
            Go to Publish →
          </button>
        </Step>

        {/* Caveats */}
        <div className="flex flex-col gap-2 mt-2 pt-4 border-t border-border">
          <h4 className="text-xs font-bold text-warning font-sans uppercase tracking-wider">
            Things to know
          </h4>
          <ul className="text-xs text-text-muted font-sans leading-relaxed list-disc pl-5 flex flex-col gap-1">
            <li>
              <strong className="text-text-dim">Keep the terminal open.</strong> Closing the tunnel
              command takes your endpoint offline.
            </li>
            <li>
              <strong className="text-text-dim">Keep your PC awake.</strong> Laptop sleep mode =
              endpoint down. AgentGate pre-flights every paid request, so buyers are never charged
              for a dead backend — but they also won't buy if your endpoint is flaky.
            </li>
            <li>
              <strong className="text-text-dim">Quick mode URLs change on restart.</strong> For a
              permanent URL, sign up for a free Cloudflare account and run{" "}
              <code className="font-mono text-text-dim">cloudflared tunnel login</code>, then create
              a named tunnel pointed at a subdomain you own.{" "}
              <a
                href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Full guide
              </a>
              .
            </li>
            <li>
              <strong className="text-text-dim">Model choice matters.</strong> Bigger models =
              slower replies = higher chance of buyer timeout. Start with a small model
              (llama3:8b) and scale up only if your hardware handles it fast.
            </li>
          </ul>
        </div>
      </div>

      {/* ── Placeholder for future guides ────────────────────────────────── */}
      <div className="card border-dashed text-center py-6">
        <p className="text-xs text-text-muted font-sans">
          More guides coming soon — Stable Diffusion, local RAG, custom APIs.
        </p>
      </div>
    </div>
  );
}
