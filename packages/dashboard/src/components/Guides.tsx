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

// IMPORTANT: --http-host-header is required because Ollama validates the
// incoming Host header as a DNS-rebinding defense. Without this flag, Ollama
// returns 403 Forbidden for every request that comes through the tunnel.
const TUNNEL_COMMAND =
  "cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434";

/**
 * Builds a self-contained prompt a publisher can paste into Claude Code,
 * Claude desktop with tool use, or claude.ai. Claude then walks through /
 * executes every step of the local Ollama + cloudflared + AgentGate setup.
 * We inject window.location.origin so Claude knows exactly which dashboard
 * to send the user back to at the end.
 */
function buildLetClaudePrompt(): string {
  const dashboardUrl = typeof window !== "undefined" ? window.location.origin : "https://your-agentgate-dashboard";
  return `I want to monetize my local Ollama installation via AgentGate, a USDC pay-per-call middleware. My goal: run a small LLM on my own machine and let AI agents pay me in USDC for each inference call.

Please run each step below and report back after each one. If you can't execute commands directly (e.g. you're the web app, not Claude Code), walk me through each command and wait for me to paste the output.

# Step 1 — Check tooling
- Is \`ollama\` installed? If not, tell me to install it from https://ollama.com/download
- Is \`cloudflared\` installed? If not, install it:
  - macOS: \`brew install cloudflared\`
  - Linux: \`curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb\`
  - Windows: \`winget install --id Cloudflare.cloudflared\`

# Step 2 — Pull a small model
Run \`ollama list\` first. If it doesn't show qwen2.5:3b or llama3.2:3b, pull one:
\`\`\`
ollama pull qwen2.5:3b
\`\`\`
(1.9GB, good quality on consumer hardware. Or use llama3.2:1b / llama3.2:3b.)

# Step 3 — Restart Ollama with parallel requests enabled
This is critical. By default Ollama serializes requests to the same model — the second buyer waits for the first to finish. Fix: restart Ollama with OLLAMA_NUM_PARALLEL=2.

On macOS (if running the Ollama menubar app):
1. Quit the Ollama menubar app completely (⌘Q from the icon)
2. Start it from a terminal:
\`\`\`
OLLAMA_NUM_PARALLEL=2 ollama serve
\`\`\`

On Linux (systemd service):
\`\`\`
sudo systemctl edit ollama.service
# Add under [Service]:
# Environment="OLLAMA_NUM_PARALLEL=2"
sudo systemctl daemon-reload
sudo systemctl restart ollama
\`\`\`

Verify it's up: \`curl http://localhost:11434/api/tags\` should return JSON.

# Step 4 — Start the cloudflared tunnel
In a SECOND terminal (leave Ollama running in the first):
\`\`\`
cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434
\`\`\`

The \`--http-host-header\` flag is REQUIRED. Ollama rejects requests whose Host header doesn't match \`localhost:11434\` (DNS-rebinding protection). Without the flag every paid call returns 403.

Wait for the output to include a line like:
\`\`\`
Your quick Tunnel has been created! Visit it at:
  https://abc-def-ghi.trycloudflare.com
\`\`\`

Copy that URL.

# Step 5 — Verify the tunnel works
\`\`\`
curl https://<tunnel-url>/api/tags
\`\`\`
Replace \`<tunnel-url>\` with the URL from step 4. You should see JSON listing your models. If you get 403, cloudflared is missing the \`--http-host-header\` flag. If you get a timeout, Ollama isn't running.

# Step 6 — Test inference through the tunnel
\`\`\`
curl -X POST https://<tunnel-url>/api/chat \\
  -H "content-type: application/json" \\
  -d '{"model":"qwen2.5:3b","messages":[{"role":"user","content":"Say PING"}],"stream":false,"options":{"num_predict":5}}'
\`\`\`
You should get a JSON response with \`"content": "PING..."\`. If this works, your setup is complete.

# Step 7 — Give me the tunnel URL and stop
Print the tunnel URL clearly. I will paste it into the AgentGate Publish form at ${dashboardUrl} myself. In the form I will:
- Choose API mode
- Paste the tunnel root URL (e.g. \`https://abc-def-ghi.trycloudflare.com\`) WITHOUT \`/api/chat\` — AgentGate appends the path from the agent's request
- Set "Max concurrent" to 2 (matching OLLAMA_NUM_PARALLEL)
- Set "Payment timeout" to 180 seconds
- Set a price per call (e.g. $0.01)
- Connect my wallet and sign two transactions (USDC approve + register)

# Important caveats to remind me about
- Keep BOTH terminals open. Closing either one takes my endpoint offline.
- Cloudflare quick tunnels have a ~100s upstream timeout. Stick to small/fast models (1B-8B) or set up a named tunnel for heavier workloads.
- Laptop sleep = endpoint offline. AgentGate pre-flights each paid request so buyers won't be charged for a dead backend — but nobody will buy from a flaky endpoint.
- The tunnel URL changes every time you restart cloudflared in quick mode. For a permanent URL, sign up for a free Cloudflare account and run \`cloudflared tunnel login\`, then create a named tunnel.

Start with Step 1.`;
}

/**
 * Prominent "Let Claude do it for you" button. Copies the full setup
 * prompt to the clipboard so the user can paste into Claude Code, the
 * Claude desktop app, or claude.ai and have Claude walk/drive the setup.
 */
function LetClaudeButton() {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-accent/30 bg-accent-dim p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-accent font-sans uppercase tracking-wider">
              Shortcut
            </span>
            <span className="badge-accent text-[9px]">No terminal needed</span>
          </div>
          <p className="text-sm font-semibold text-text font-sans">
            Let Claude do it for you
          </p>
          <p className="text-xs text-text-muted font-sans leading-relaxed">
            One click copies a complete setup prompt. Paste it into{" "}
            <strong className="text-text-dim">Claude Code</strong>,{" "}
            <strong className="text-text-dim">Claude desktop app</strong>, or{" "}
            <strong className="text-text-dim">claude.ai</strong> and Claude will walk you
            through every step below — installing cloudflared, restarting Ollama with
            parallel mode, opening the tunnel, and handing you back the public URL to
            paste into the Publish form.
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(buildLetClaudePrompt());
              setState("copied");
              setTimeout(() => setState("idle"), 2500);
            } catch {
              setState("error");
              setTimeout(() => setState("idle"), 2500);
            }
          }}
          className={`shrink-0 font-mono text-xs font-bold px-4 py-2 rounded-sm border transition-all duration-150 ${
            state === "copied"
              ? "bg-success-dim border-success/30 text-success"
              : state === "error"
              ? "bg-error-dim border-error/30 text-error"
              : "bg-accent text-bg border-accent hover:bg-accent/90"
          }`}
        >
          {state === "copied" ? "✓ Copied — paste into Claude" :
           state === "error"  ? "clipboard blocked" :
                                "Copy prompt →"}
        </button>
      </div>
    </div>
  );
}

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

        {/* Shortcut: let Claude drive the whole setup */}
        <LetClaudeButton />

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
          <div className="rounded-sm px-3 py-2 text-xs bg-warning/10 border border-warning/20 text-warning">
            <strong className="font-semibold">Enable parallel requests.</strong> Ollama's default
            serializes requests to the same model — two buyers hitting you at once will wait in line
            even if your "max concurrent" on AgentGate is higher. Quit the Ollama menubar app and
            relaunch it with <code className="font-mono">OLLAMA_NUM_PARALLEL=2</code> (or more) so
            Ollama actually runs them in parallel. The cleanest way on macOS:
            <CodeBlock>{"# Quit the menubar app first, then from a terminal:\nOLLAMA_NUM_PARALLEL=2 ollama serve"}</CodeBlock>
            Benchmark on M4 / qwen2.5:3b / 30-token responses:{" "}
            <strong className="text-text-dim">default = 2 calls in 1.8s (serialized)</strong>,
            {" "}<strong className="text-text-dim">NUM_PARALLEL=2 = 2 calls in 1.6s (+25% throughput)</strong>.
            Each individual call is ~50% slower under load, but you serve more buyers.
          </div>
        </Step>

        {/* Step 3: open the tunnel */}
        <Step n={3} title="Open the tunnel">
          <p className="text-xs text-text-muted font-sans">
            In a <strong className="text-text-dim">second terminal</strong>, run:
          </p>
          <CodeBlock>{TUNNEL_COMMAND}</CodeBlock>
          <p className="text-xs text-text-muted font-sans">
            The <code className="font-mono text-text-dim">--http-host-header</code> flag is{" "}
            <strong className="text-warning">required</strong>. Ollama rejects requests whose
            Host header doesn't match <code className="font-mono text-text-dim">localhost:11434</code>{" "}
            (DNS-rebinding protection). Without the flag, every paid call returns 403.
          </p>
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
            Go to the Publish tab, choose <strong className="text-text-dim">API</strong> mode, and paste{" "}
            <strong className="text-text-dim">only the tunnel root URL</strong> (no path suffix). AgentGate
            appends whatever path the agent requests, so the agent will call{" "}
            <code className="font-mono text-text-dim">/api/proxy/ID/api/chat</code> and AgentGate will
            forward it to <code className="font-mono text-text-dim">tunnel-root/api/chat</code>.
          </p>
          <CodeBlock>https://random-words-1234.trycloudflare.com</CodeBlock>
          <div className="rounded-sm px-3 py-2 text-xs bg-warning/10 border border-warning/20 text-warning">
            <strong className="font-semibold">Don't append</strong>{" "}
            <code className="font-mono">/api/chat</code> to the backend URL — AgentGate concatenates the
            agent's request path to the backend, so you'd end up calling{" "}
            <code className="font-mono">tunnel/api/chat/api/chat</code> → 404.
          </div>
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
              <strong className="text-text-dim">Cloudflare quick tunnels have a ~100s upstream timeout.</strong>{" "}
              If your model takes longer than 100s to respond (for example a 30B+ model on modest hardware),
              the tunnel returns HTTP 524 and your agent never gets the reply. Stick to small/fast models
              (1B–8B) on quick tunnels, or use a named tunnel which has higher limits.
            </li>
            <li>
              <strong className="text-text-dim">Model choice matters.</strong> Bigger models =
              slower replies = higher chance of buyer timeout. Start with a small model
              (llama3:8b) and scale up only if your hardware handles it fast.
            </li>
            <li>
              <strong className="text-text-dim">Match AgentGate "max concurrent" to OLLAMA_NUM_PARALLEL.</strong>{" "}
              If you set AgentGate to allow 4 concurrent calls but Ollama only handles 2 in
              parallel, the 3rd and 4th buyers will wait for an Ollama slot even after AgentGate
              let them through. Keep the two numbers in sync.
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
