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
import * as readline from "readline";

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

function parseSharePct(raw: string): number | null {
  const s = raw.toLowerCase().trim();
  if (s in SHARE_PRESETS) return SHARE_PRESETS[s];
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
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

function planHardwareShare(sharePct: number): HardwarePlan {
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
    // Symlink hardening: another user on a shared box (or a hostile process)
    // could have pre-created TOKEN_FILE as a symlink to /tmp/leak or similar.
    // fs.writeFileSync follows symlinks, so the token would land at the
    // attacker's target with their permissions. Unlink any pre-existing
    // symlink before writing, then create a fresh regular file.
    try {
      const st = fs.lstatSync(TOKEN_FILE);
      if (st.isSymbolicLink() || !st.isFile()) {
        fs.unlinkSync(TOKEN_FILE);
      }
    } catch { /* not present or not accessible — writeFileSync will handle */ }
    // Open with O_EXCL-style semantics by unlinking first + writing fresh.
    // `flag: "wx"` would throw on existing; we've already removed above so
    // this line always creates a new file.
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: "w" });
    // Defensive chmod for the case where the file pre-existed with laxer perms.
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* ignore */ }
  } catch (err: any) {
    console.warn(`  ⚠  Could not persist rotated token to ${TOKEN_FILE}: ${err.message}`);
  }
}

// ── Share preference persistence ────────────────────────────────────────────
// First-run prompt lets the publisher pick how much of their box they want
// AgentGate to use. Saved to ~/.agentgate/share so subsequent runs don't
// re-ask. Env var AGENTGATE_SHARE always wins over the persisted file (easy
// override for CI, one-off experiments, or scripts).
const SHARE_FILE = path.join(TOKEN_DIR, "share");

function readPersistedShare(): number | null {
  try {
    if (!fs.existsSync(SHARE_FILE)) return null;
    return parseSharePct(fs.readFileSync(SHARE_FILE, "utf-8"));
  } catch { return null; }
}

function writePersistedShare(pct: number) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SHARE_FILE, String(pct));
  } catch { /* non-fatal — we'll re-prompt next time */ }
}

async function promptSharePct(): Promise<number> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`
  🎛  First run — how much of your machine should AgentGate use?

     \x1b[1m1)\x1b[0m Light     — 30%   barely noticeable, share casually
     \x1b[1m2)\x1b[0m Balanced  — 50%   share while you work
     \x1b[1m3)\x1b[0m Heavy     — 70%   \x1b[2m(default)\x1b[0m dedicated-ish hosting
     \x1b[1m4)\x1b[0m Max       — 100%  all yours
`);
    rl.question("  > Choose [1-4, Enter = 3]: ", (answer) => {
      rl.close();
      const n = answer.trim();
      const pct = n === "1" ? 30 : n === "2" ? 50 : n === "4" ? 100 : 70;
      console.log(`  ✓ Saved — \x1b[1m${pct}%\x1b[0m (change later via \x1b[1mAGENTGATE_SHARE=\x1b[0m env or edit ${SHARE_FILE})\n`);
      resolve(pct);
    });
  });
}

/**
 * Resolve the share-of-machine percentage. Precedence:
 *   1. AGENTGATE_SHARE env var (explicit, always wins)
 *   2. Persisted ~/.agentgate/share file (set on first interactive run)
 *   3. Interactive prompt when stdin is a TTY (and persists for next time)
 *   4. Default 70% (non-TTY / CI fallback)
 */
async function resolveSharePct(): Promise<number> {
  const envRaw = process.env.AGENTGATE_SHARE;
  if (envRaw) {
    const parsed = parseSharePct(envRaw);
    if (parsed !== null) return parsed;
  }
  const persisted = readPersistedShare();
  if (persisted !== null) return persisted;
  if (process.stdin.isTTY) {
    const chosen = await promptSharePct();
    writePersistedShare(chosen);
    return chosen;
  }
  return 70;
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

function checkOllamaBinary(): boolean {
  try {
    execSync("which ollama", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `ollama serve` as a child process with the NUM_PARALLEL / NUM_THREAD
 * the hardware planner picked, and wait until /api/tags responds. Ollama
 * reads its own tuning env on startup, so this is the only reliable way to
 * apply OLLAMA_NUM_PARALLEL without asking the publisher to type it. The
 * returned ChildProcess is kept alive by the caller and killed on Ctrl+C.
 *
 * Skip if an Ollama is already listening — we don't want to stomp on an
 * existing session that might be shared with other apps. Callers handle
 * the "already running but with NUM_PARALLEL=1" case separately.
 */
async function spawnOllamaIfNeeded(plan: HardwarePlan): Promise<ChildProcess | null> {
  // Is something already listening? If yes, leave it.
  const existing = await checkOllama();
  if (existing.length > 0) return null;

  if (!checkOllamaBinary()) {
    fatal(
      `Ollama is not running and not installed.\n` +
      `     Install it from: https://ollama.com/download\n` +
      `     Then re-run this CLI — we'll start it for you.`
    );
  }

  log("🚀", `Starting ollama serve with NUM_PARALLEL=${plan.plannedParallel}, NUM_THREAD=${plan.plannedThreads}...`);

  const child = spawn("ollama", ["serve"], {
    env: {
      ...process.env,
      OLLAMA_NUM_PARALLEL: String(plan.plannedParallel),
      OLLAMA_NUM_THREAD:   String(plan.plannedThreads),
      // Don't override MAX_LOADED_MODELS / HOST — publisher's env wins.
    },
    stdio: ["ignore", "ignore", "pipe"], // drop stdout, capture stderr for errors
  });

  child.on("error", (err) => {
    fatal(`Failed to launch Ollama: ${(err as any).message || String(err)}`);
  });

  // Poll /api/tags until Ollama is ready (up to 30s — first launch can be
  // slow because Ollama scans model blobs on startup).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const models = await checkOllama();
    if (models.length > 0) {
      log("✅", `Ollama up — ${models.length} model${models.length > 1 ? "s" : ""}`);
      return child;
    }
    if (child.exitCode !== null) {
      fatal(`Ollama exited early (code ${child.exitCode}) during startup.`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  fatal("Ollama didn't become ready within 30s. Try starting it manually first.");
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

async function detectOllamaConfig(hw: HardwarePlan): Promise<DetectedConfig | null> {
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

  // Step 1a: Resolve share preference FIRST (interactive prompt on first run,
  // persisted to ~/.agentgate/share for subsequent runs). We need the plan
  // BEFORE checking Ollama so we can launch it with the right NUM_PARALLEL
  // when it isn't running yet. AGENTGATE_SHARE env var overrides.
  const sharePct = await resolveSharePct();
  const hw = planHardwareShare(sharePct);

  // Step 1b: Check Ollama. If it's running, use it. If it isn't, we spawn
  // it ourselves with the planner's NUM_PARALLEL — no "please restart with
  // OLLAMA_NUM_PARALLEL=X" dance for the publisher.
  log("🔍", "Checking Ollama...");
  const ollamaChild = await spawnOllamaIfNeeded(hw);
  const models = await checkOllama();
  if (models.length === 0) {
    fatal(
      `Ollama is not running on port ${OLLAMA_PORT}.\n` +
      `     Start it with: ollama serve\n` +
      `     Or install from: https://ollama.com/download`
    );
  }
  log("✅", `Ollama ${ollamaChild ? "managed by CLI" : "already running"} — ${models.length} model${models.length > 1 ? "s" : ""}: ${models.join(", ")}`);
  // If we started Ollama ourselves, reflect that in OUR env so the hw plan's
  // `currentParallel` matches reality (no spurious "under-provisioned" warn).
  if (ollamaChild) {
    process.env.OLLAMA_NUM_PARALLEL = String(hw.plannedParallel);
  }
  const hwFinal = planHardwareShare(sharePct);

  // Step 1b: Auto-detect advanced settings from /api/show so the publisher
  // never has to fill pricing/max_tokens/concurrency/timeout by hand.
  // Failure here is non-fatal — we still register the tunnel, the dashboard
  // defaults just stay in effect.
  const detected = await detectOllamaConfig(hwFinal);
  if (detected) {
    const hwLine =
      `${hwFinal.cores} cores · ${hwFinal.totalMemGB}GB RAM` +
      (hwFinal.isAppleSilicon ? " · Apple Silicon (UMA)" : "") +
      ` · ${hwFinal.platform}/${hwFinal.arch}`;

    const underProvisioned = hwFinal.currentParallel < hwFinal.plannedParallel;
    const ollamaCmd = `OLLAMA_NUM_PARALLEL=${hwFinal.plannedParallel} OLLAMA_NUM_THREAD=${hwFinal.plannedThreads} ollama serve`;

    console.log(`
  💻 System
     Hardware:    ${hwLine}
     Share level: ${hwFinal.sharePct}% (AGENTGATE_SHARE — set light/balanced/heavy/max or 1-100)
     Plan:        ${hwFinal.plannedParallel} parallel slot${hwFinal.plannedParallel === 1 ? "" : "s"} · ${hwFinal.plannedThreads} threads
     Ollama now:  NUM_PARALLEL=${hwFinal.currentParallel}${underProvisioned ? " \x1b[33m(under-provisioned — Ollama was already running with a lower cap)\x1b[0m" : ` \x1b[32m✓${ollamaChild ? " (managed by CLI)" : ""}\x1b[0m`}

  🧠 Endpoint
     Model:       ${detected.model}
     Context:     ${detected.contextLength.toLocaleString()} tokens  → input cap ${detected.maxInputTokens.toLocaleString()}, output cap ${detected.maxOutputTokens.toLocaleString()}
     Pricing:     $${detected.pricePerMillionTokens.toFixed(2)} / 1M tokens
     Capacity:    ${detected.maxConcurrent} concurrent buyer${detected.maxConcurrent === 1 ? "" : "s"}${underProvisioned ? `\n     💡 Ollama is already running with a lower cap. Stop it (Ctrl+C in its window)\n        and re-run this CLI — we'll start Ollama with:\n        \x1b[1m${ollamaCmd}\x1b[0m` : ""}
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

  // Handle cleanup on SIGINT/SIGTERM. If we spawned Ollama ourselves, also
  // stop it — we don't want to leave a stray ollama serve behind that
  // could confuse the publisher on the next run.
  const cleanup = () => {
    console.log("\n");
    log("🛑", "Shutting down tunnel...");
    try { cfProcess.kill("SIGTERM"); } catch { /* ignore */ }
    if (ollamaChild) {
      log("🛑", "Stopping Ollama (CLI-managed)...");
      try { ollamaChild.kill("SIGTERM"); } catch { /* ignore */ }
    }
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
