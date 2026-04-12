#!/usr/bin/env node
/**
 * @agentgate/cli — One command to monetize your local AI.
 *
 * Usage:
 *   npx @agentgate/cli tunnel --token agt_xxxxx
 *
 * What it does:
 *   1. Checks Ollama is running locally
 *   2. Checks cloudflared is installed
 *   3. Starts a Cloudflare quick tunnel with the right flags
 *   4. Sends the tunnel URL to the AgentGate server (token auth, no wallet)
 *   5. Stays running — Ctrl+C to stop
 *
 * The tunnel token is generated when you publish from the dashboard.
 * It lets the CLI update the backend URL without a wallet signature.
 */

import { spawn, execSync, type ChildProcess } from "child_process";

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = process.env.AGENTGATE_SERVER || "https://agentgate-server.onrender.com";
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || "11434", 10);

// ── Helpers ─────────────────────────────────────────────────────────────────

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

async function setTunnelUrl(token: string, tunnelUrl: string): Promise<{
  ok: boolean;
  endpointId?: number;
  proxyUrl?: string;
  error?: string;
}> {
  try {
    const res = await fetch(`${SERVER_URL}/api/publisher/proxy-config/set-tunnel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, tunnelUrl }),
      signal: AbortSignal.timeout(10000),
    });
    return (await res.json()) as any;
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── Tunnel command ──────────────────────────────────────────────────────────

async function runTunnel(token: string) {
  console.log("\n  ◆ AgentGate CLI\n");

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
  const result = await setTunnelUrl(token, tunnelUrl);

  if (!result.ok) {
    cfProcess.kill("SIGTERM");
    fatal(`Failed to register tunnel: ${result.error}`);
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
  const tokenIdx = args.indexOf("--token");
  const token = tokenIdx >= 0 ? args[tokenIdx + 1] : process.env.AGENTGATE_TOKEN;

  if (!token) {
    console.log(`
  ◆ AgentGate CLI

  Usage:
    agentgate tunnel --token <your-tunnel-token>

  The tunnel token is shown once when you publish an endpoint from
  the dashboard. You can also set it via the AGENTGATE_TOKEN env var.

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
  console.log(`
  ◆ AgentGate CLI

  Commands:
    tunnel   Start a tunnel to your local Ollama and register it with AgentGate

  Example:
    agentgate tunnel --token agt_xxxxxxxxxxxx

  Get your tunnel token by publishing an endpoint from the AgentGate dashboard.
`);
}
