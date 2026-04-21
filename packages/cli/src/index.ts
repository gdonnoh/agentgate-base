#!/usr/bin/env node
/**
 * @agentgate/cli — One command to monetize your local AI.
 *
 * Usage:
 *   AGENTGATE_TOKEN=agt_xxxxx agentgate tunnel
 *
 * What it does:
 *   1. Checks Ollama is running locally
 *   2. Checks cloudflared is installed
 *   3. Starts a Cloudflare quick tunnel with the right flags
 *   4. Sends the tunnel URL to the AgentGate server (token auth, no wallet)
 *   5. Stays running — Ctrl+C to stop
 *
 * Security (R2-F): the token must come from the AGENTGATE_TOKEN environment
 * variable or from the on-disk persistence file at ~/.agentgate/token (mode
 * 0600). We removed the --token CLI flag because flags are logged in shell
 * history and ps(1) output, making token exfiltration trivial on shared
 * hosts.
 *
 * The server rotates the tunnel token on every successful set-tunnel call
 * (R2-E). We persist the rotated token back to ~/.agentgate/token so the
 * next tunnel run picks up the new value automatically.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = process.env.AGENTGATE_SERVER || "https://agentgate-server.onrender.com";
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || "11434", 10);

// ── Hardware share planning ─────────────────────────────────────────────────
// Publisher declares how much of their machine AgentGate is allowed to use.
// Accepted inputs:
//   AGENTGATE_SHARE=30    → 30%
//   AGENTGATE_SHARE=0.3   → same (shortcut)
//   AGENTGATE_SHARE=heavy → alias for 70
// Default: 70 (balanced — most hobbyist publishers are fine giving most of
// the box when no one else is actively using it, since Ollama only pulls
// resources when a request is in flight).
const SHARE_PRESETS: Record<string, number> = {
  light: 30, balanced: 50, heavy: 70, max: 100,
};

function readSharePct(): number {
  const raw = (process.env.AGENTGATE_SHARE || "70").toLowerCase().trim();
  if (raw in SHARE_PRESETS) return SHARE_PRESETS[raw];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 70;
  // Accept both 0.3 and 30 for 30%.
  const pct = n <= 1 ? n * 100 : n;
  return Math.max(5, Math.min(100, Math.round(pct)));
}

interface HardwarePlan {
  sharePct: number;
  cores: number;
  totalMemGB: number;
  platform: string;
  arch: string;
  isAppleSilicon: boolean;
  plannedParallel: number;
  plannedThreads: number;
  currentParallel: number;
  plannedIsActive: boolean;
}

function planHardwareShare(): HardwarePlan {
  const sharePct = readSharePct();
  const cores = os.cpus().length;
  const totalMemGB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
  const platform = os.platform();
  const arch = os.arch();
  const isAppleSilicon = platform === "darwin" && arch === "arm64";

  // Threads: a linear fraction of available cores.
  const plannedThreads = Math.max(1, Math.floor((cores * sharePct) / 100));

  // Parallel slots: each slot wants ~3GB breathing room on consumer hardware
  // (model weights + KV cache overhead). Apple Silicon unified memory means
  // all RAM counts as effective VRAM, so we can be a touch more generous.
  const memBudgetGB = (totalMemGB * sharePct) / 100;
  const perSlotGB   = isAppleSilicon ? 2.5 : 3.5;
  const plannedParallel = Math.max(
    1,
    Math.min(8, Math.floor(memBudgetGB / perSlotGB)),
  );

  const currentParallel = Math.max(
    1,
    parseInt(process.env.OLLAMA_NUM_PARALLEL || "1", 10) || 1,
  );
  const plannedIsActive = currentParallel === plannedParallel;

  return {
    sharePct, cores, totalMemGB, platform, arch, isAppleSilicon,
    plannedParallel, plannedThreads, currentParallel, plannedIsActive,
  };
}

// ── Token persistence (R2-E / R2-F) ─────────────────────────────────────────
// Stored outside the repo at ~/.agentgate/token with mode 0600 so other
// users on the machine can't read it. Written only after a successful
// set-tunnel call so we only persist tokens that actually worked.
const TOKEN_DIR  = path.join(os.homedir(), ".agentgate");
const TOKEN_FILE = path.join(TOKEN_DIR, "token");

function readPersistedToken(): string | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const t = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    return t || null;
  } catch { return null; }
}

function writePersistedToken(token: string) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    // Defensive chmod for the case where the file pre-existed with laxer perms.
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* ignore */ }
  } catch (err: any) {
    console.warn(`  ⚠  Could not persist rotated token to ${TOKEN_FILE}: ${err.message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// ANSI Shadow font — blue vertical gradient. Skip colors when not a TTY so
// piping to a log file doesn't leave escape codes littered through it.
const BANNER_ROWS = [
  " █████╗  ██████╗ ███████╗███╗   ██╗████████╗ ██████╗  █████╗ ████████╗███████╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║  ███╗███████║   ██║   █████╗  ",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║   ██║██╔══██║   ██║   ██╔══╝  ",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ╚██████╔╝██║  ██║   ██║   ███████╗",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝",
];
const BANNER_GRADIENT = [51, 45, 39, 33, 27, 21]; // bright cyan → dark blue
const TAGLINE = "One command to monetize your local AI — x402 on Base Sepolia";

function printBanner() {
  if (process.stdout.isTTY) {
    console.log();
    BANNER_ROWS.forEach((row, i) => {
      const color = BANNER_GRADIENT[i] ?? 39;
      console.log(`\x1b[38;5;${color}m\x1b[1m${row}\x1b[0m`);
    });
    // Dim tagline, centered under the banner
    console.log(`\x1b[2m${" ".repeat(10)}${TAGLINE}\x1b[0m\n`);
  } else {
    console.log("\n  AgentGate CLI\n");
  }
}

function log(icon: string, msg: string) {
  console.log(`  ${icon}  ${msg}`);
}

function fatal(msg: string): never {
  console.error(`\n  ❌  ${msg}\n`);
  process.exit(1);
}

async function checkOllama(): Promise<string[]> {
  try {
    const res = await fetch(`http://localhost:${OLLAMA_PORT}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return (data.models || []).map((m: any) => m.name as string);
  } catch {
    return [];
  }
}

// ── Auto-detection (Option A) ───────────────────────────────────────────────
// Publishers shouldn't have to fill in max_tokens / concurrency / pricing /
// timeout on the dashboard when the local Ollama install already knows its
// own context length. We GET /api/tags, POST /api/show on the first model,
// extract the context window from model_info.<arch>.context_length, and
// derive sensible caps + a pricing guess from the model name.

export interface DetectedConfig {
  contentType: "api";
  pricingModel: "perToken";
  allowedPaths: string[];
  model: string;
  /** Full list of model names from /api/tags — server merges into proxy config
   *  so the paywall chat UI can render a model dropdown for the buyer. */
  models: string[];
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** USD per 1,000,000 tokens — the server converts to whatever units it stores. */
  pricePerMillionTokens: number;
  maxConcurrent: number;
  paymentTimeoutSeconds: number;
}

/**
 * Pull the context window out of Ollama's /api/show response. Different
 * architectures namespace the key under their own prefix (llama, mistral,
 * qwen2, phi3, gemma2, ...), so we scan generically for any *.context_length
 * key rather than hard-coding archs.
 */
function extractContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo || typeof modelInfo !== "object") return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Heuristic price guess based on model name. These are publish-time defaults —
 * the publisher can still override them from the dashboard if they want.
 */
function guessPricePerMillionTokens(modelName: string): number {
  const n = modelName.toLowerCase();
  if (n.includes("70b") || n.includes("72b")) return 5.0;
  if (n.includes("34b") || n.includes("33b")) return 2.0;
  if (n.includes("13b")) return 1.0;
  if (n.includes("8b")  || n.includes("7b"))  return 0.5;
  if (n.includes("3b")  || n.includes("1b"))  return 0.2;
  return 0.5;
}

async function detectOllamaConfig(): Promise<DetectedConfig | null> {
  try {
    const tagsRes = await fetch(`http://localhost:${OLLAMA_PORT}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!tagsRes.ok) return null;
    const tagsData = (await tagsRes.json()) as any;
    const models: any[] = Array.isArray(tagsData.models) ? tagsData.models : [];
    if (models.length === 0) return null;

    const firstModel = models[0]?.name;
    if (!firstModel || typeof firstModel !== "string") return null;

    // Collect the full list so the paywall chat UI can show a dropdown.
    const allModels: string[] = models
      .map((m) => (typeof m?.name === "string" ? m.name : null))
      .filter((n): n is string => !!n);

    const showRes = await fetch(`http://localhost:${OLLAMA_PORT}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: firstModel }),
      signal: AbortSignal.timeout(5000),
    });
    if (!showRes.ok) return null;
    const showData = (await showRes.json()) as any;

    const contextLength = extractContextLength(showData?.model_info);
    if (!contextLength) return null;

    // Typical 60/40 split: reserve most of the window for prompt + context,
    // leave ~40% for generation. Publishers can still override later.
    const maxInputTokens  = Math.floor(contextLength * 0.6);
    const maxOutputTokens = Math.floor(contextLength * 0.4);

    // True concurrency cap for the endpoint is the MIN of:
    //   - what Ollama is actually willing to batch (OLLAMA_NUM_PARALLEL)
    //   - what the hardware share plan says the box can support
    // This prevents promising 4 parallel slots to buyers when Ollama is
    // actually serialising (NUM_PARALLEL=1) — buyers would just queue up.
    const hw = planHardwareShare();
    const effectiveParallel = Math.min(hw.currentParallel, hw.plannedParallel);

    return {
      contentType: "api",
      pricingModel: "perToken",
      allowedPaths: ["/api/chat", "/api/generate", "/api/embeddings", "/v1/"],
      model: firstModel,
      models: allModels,
      contextLength,
      maxInputTokens,
      maxOutputTokens,
      pricePerMillionTokens: guessPricePerMillionTokens(firstModel),
      maxConcurrent: effectiveParallel,
      paymentTimeoutSeconds: 60,
    };
  } catch {
    return null;
  }
}

function checkCloudflared(): boolean {
  try {
    execSync("which cloudflared", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractTunnelUrl(output: string): string | null {
  // Cloudflared prints the URL in a box like:
  //   |  https://abc-def.trycloudflare.com  |
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

async function setTunnelUrl(
  token: string,
  tunnelUrl: string,
  detected: DetectedConfig | null,
): Promise<{
  ok: boolean;
  endpointId?: number;
  proxyUrl?: string;
  nextToken?: string;
  detected?: Partial<DetectedConfig>;
  error?: string;
}> {
  try {
    const res = await fetch(`${SERVER_URL}/api/publisher/proxy-config/set-tunnel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // R2-E nonce — the server remembers the last N nonces per endpoint
        // and rejects replays, so a captured request body can't be resent.
        "x-tunnel-nonce": randomUUID(),
      },
      // CLI is authoritative: every connect pushes the freshly-detected
      // config so the dashboard never needs to be re-edited. Older servers
      // that don't know about `detected` just ignore the extra field.
      body: JSON.stringify({ token, tunnelUrl, detected }),
      signal: AbortSignal.timeout(10000),
    });
    return (await res.json()) as any;
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── Tunnel command ──────────────────────────────────────────────────────────

async function runTunnel(token: string) {
  printBanner();

  // Step 1: Check Ollama
  log("🔍", "Checking Ollama...");
  const models = await checkOllama();
  if (models.length === 0) {
    fatal(
      `Ollama is not running on port ${OLLAMA_PORT}.\n` +
      `     Start it with: ollama serve\n` +
      `     Or install from: https://ollama.com/download`
    );
  }
  log("✅", `Ollama running — ${models.length} model${models.length > 1 ? "s" : ""}: ${models.join(", ")}`);

  // Step 1b: Auto-detect advanced settings from /api/show so the publisher
  // never has to fill pricing/max_tokens/concurrency/timeout by hand.
  // Failure here is non-fatal — we still register the tunnel, the dashboard
  // defaults just stay in effect.
  const detected = await detectOllamaConfig();
  if (detected) {
    const hw = planHardwareShare();
    const hwLine =
      `${hw.cores} cores · ${hw.totalMemGB}GB RAM` +
      (hw.isAppleSilicon ? " · Apple Silicon (UMA)" : "") +
      ` · ${hw.platform}/${hw.arch}`;

    // Only nag the publisher when Ollama's actual NUM_PARALLEL is below
    // what the hardware plan could support. If the planner itself decided 1
    // slot (tiny machine) there's nothing to unlock and we stay quiet.
    const underProvisioned = hw.currentParallel < hw.plannedParallel;
    const ollamaCmd = `OLLAMA_NUM_PARALLEL=${hw.plannedParallel} OLLAMA_NUM_THREAD=${hw.plannedThreads} ollama serve`;

    console.log(`
  💻 System
     Hardware:    ${hwLine}
     Share level: ${hw.sharePct}% (AGENTGATE_SHARE — set light/balanced/heavy/max or 1-100)
     Plan:        ${hw.plannedParallel} parallel slot${hw.plannedParallel === 1 ? "" : "s"} · ${hw.plannedThreads} threads
     Ollama now:  NUM_PARALLEL=${hw.currentParallel}${underProvisioned ? " \x1b[33m(under-provisioned)\x1b[0m" : " \x1b[32m✓\x1b[0m"}

  🧠 Endpoint
     Model:       ${detected.model}
     Context:     ${detected.contextLength.toLocaleString()} tokens  → input cap ${detected.maxInputTokens.toLocaleString()}, output cap ${detected.maxOutputTokens.toLocaleString()}
     Pricing:     $${detected.pricePerMillionTokens.toFixed(2)} / 1M tokens
     Capacity:    ${detected.maxConcurrent} concurrent buyer${detected.maxConcurrent === 1 ? "" : "s"}${underProvisioned ? `\n     💡 To unlock ${hw.plannedParallel} slots restart Ollama:\n        \x1b[1m${ollamaCmd}\x1b[0m\n        then re-run this CLI.` : ""}
`);
  } else {
    log("ℹ️ ", "Could not auto-detect Ollama model info — dashboard defaults will be used.");
  }

  // Step 2: Check cloudflared
  log("🔍", "Checking cloudflared...");
  if (!checkCloudflared()) {
    fatal(
      `cloudflared not found.\n` +
      `     Install with: brew install cloudflared (macOS)\n` +
      `     Or download from: https://github.com/cloudflare/cloudflared/releases`
    );
  }
  log("✅", "cloudflared found");

  // Step 3: Start tunnel
  log("🚀", "Starting Cloudflare tunnel...");
  const cfProcess: ChildProcess = spawn("cloudflared", [
    "tunnel",
    "--url", `http://localhost:${OLLAMA_PORT}`,
    "--http-host-header", `localhost:${OLLAMA_PORT}`,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let tunnelUrl: string | null = null;

  // Handle cleanup on SIGINT/SIGTERM
  const cleanup = () => {
    console.log("\n");
    log("🛑", "Shutting down tunnel...");
    cfProcess.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Wait for the tunnel URL to appear in stderr
  tunnelUrl = await new Promise<string>((resolve, reject) => {
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for tunnel URL (30s). Is cloudflared working?"));
    }, 30000);

    cfProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const url = extractTunnelUrl(stderrBuf);
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });

    cfProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    cfProcess.on("exit", (code) => {
      if (!tunnelUrl) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });

  log("✅", `Tunnel live: ${tunnelUrl}`);

  // Step 4: Register with AgentGate server
  log("🔗", `Registering tunnel with AgentGate server...`);
  const result = await setTunnelUrl(token, tunnelUrl, detected);

  if (!result.ok) {
    cfProcess.kill("SIGTERM");
    fatal(`Failed to register tunnel: ${result.error}`);
  }

  // R2-E: persist the rotated token so the next run picks it up without
  // the user having to re-export AGENTGATE_TOKEN. If the server didn't
  // return one (older server) we just keep the existing token.
  if (result.nextToken && result.nextToken !== token) {
    writePersistedToken(result.nextToken);
    log("🔑", "Tunnel token rotated — new token stored at ~/.agentgate/token");
  }

  // Step 5: Success — print summary and wait
  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │   ◆ Endpoint #${String(result.endpointId ?? "?").padEnd(4)} is live                          │
  │                                                         │
  │   Proxy URL:  ${SERVER_URL}${result.proxyUrl}${" ".repeat(Math.max(0, 22 - (result.proxyUrl?.length ?? 0)))}│
  │   Tunnel:     ${tunnelUrl}${" ".repeat(Math.max(0, 43 - tunnelUrl.length))}│
  │   Models:     ${models.slice(0, 3).join(", ").slice(0, 40).padEnd(41)}│
  │                                                         │
  │   Press Ctrl+C to stop.                                 │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
`);

  // Keep the process alive — cloudflared runs as a child
  // If cloudflared crashes, we exit too
  cfProcess.on("exit", (code) => {
    log("⚠️", `cloudflared exited (code ${code}). Restarting is recommended.`);
    process.exit(1);
  });
}

// ── CLI entry ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === "tunnel") {
  // R2-F: token ONLY from env or persisted file. We no longer accept --token
  // via argv because flags land in shell history and ps(1) output.
  // Precedence: env var > persisted file.
  const envToken = process.env.AGENTGATE_TOKEN;
  const fileToken = readPersistedToken();
  const token = envToken || fileToken;

  // Explicit rejection: if the user still passes --token we want to exit with
  // a clear message rather than silently ignoring it.
  if (args.includes("--token")) {
    console.error(`
  ❌  The --token flag has been removed for security reasons.

      Use the AGENTGATE_TOKEN environment variable instead:
        AGENTGATE_TOKEN=agt_xxxxx agentgate tunnel

      Or save it once to ~/.agentgate/token (mode 0600).
`);
    process.exit(1);
  }

  if (!token) {
    printBanner();
    console.log(`  Usage:
    AGENTGATE_TOKEN=<your-tunnel-token> agentgate tunnel

  The tunnel token is shown once when you publish an endpoint from
  the dashboard. Set it via the AGENTGATE_TOKEN environment variable,
  or save it once to ~/.agentgate/token (mode 0600) and this CLI will
  pick it up automatically.

  Token rotation: the server rotates your token on every successful
  connect. The new value is persisted to ~/.agentgate/token so your
  next run works without any extra setup.

  What this does:
    1. Checks Ollama is running locally
    2. Checks cloudflared is installed
    3. Starts a Cloudflare quick tunnel (with Ollama DNS fix)
    4. Registers the tunnel URL with AgentGate (no wallet needed)
    5. Stays running until you press Ctrl+C
`);
    process.exit(1);
  }

  runTunnel(token).catch((err) => {
    fatal(err.message || String(err));
  });
} else {
  printBanner();
  console.log(`  Commands:
    tunnel   Start a tunnel to your local Ollama and register it with AgentGate

  Example:
    AGENTGATE_TOKEN=agt_xxxxxxxxxxxx agentgate tunnel

  Get your tunnel token by publishing an endpoint from the AgentGate dashboard.
`);
}
