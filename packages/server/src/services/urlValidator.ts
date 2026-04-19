/**
 * urlValidator.ts
 *
 * SSRF guard for user-supplied backend URLs. Publishers can register a
 * `backendUrl` that the proxy fetches on their behalf — without the checks
 * below a malicious publisher could point this at cloud metadata services,
 * RFC1918 ranges, or localhost to attack the server itself or its neighbours.
 *
 * `validateBackendUrl` throws with a clear message when the URL is unsafe.
 * It must be called at every code path that accepts a backendUrl from the
 * outside world (POST /proxy-config, POST /proxy-config/set-tunnel,
 * POST /test-backend, …).
 */

// Recognised tunnel providers. Historically these resolve to external IPs and
// are the approved way to expose a local backend, so they bypass the
// http-in-prod check (they're always HTTPS in practice anyway, but we keep
// the list for clarity).
const TUNNEL_HOST_SUFFIXES = [
  ".trycloudflare.com",
  ".cloudflare.com",
  ".cfargotunnel.com",
  ".ngrok.io",
  ".ngrok-free.app",
  ".ngrok.app",
  ".ngrok.dev",
];

function isTunnelHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return TUNNEL_HOST_SUFFIXES.some((sfx) => h === sfx.slice(1) || h.endsWith(sfx));
}

/**
 * IPv4 parsing — returns [a, b, c, d] or null if not a valid dotted quad.
 * We can't rely on Node's net.isIP-style helpers for CIDR checks, and the
 * hostname may already have been resolved by a DNS rebinder; we simply reject
 * anything that LOOKS like a private range by string form.
 */
function parseIPv4(hostname: string): [number, number, number, number] | null {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  for (const p of parts) {
    if (!Number.isFinite(p) || p < 0 || p > 255) return null;
  }
  return parts;
}

function isPrivateIPv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 — 172.16.x.x through 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local + AWS EC2 metadata (169.254.169.254)
  if (a === 169 && b === 254) return true;
  return false;
}

function isBlockedIPv6(hostname: string): boolean {
  // Strip zone id (fe80::1%eth0) and any brackets.
  const h = hostname.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!h.includes(":")) return false;

  // ::1 loopback (written as [::1] or 0000:0000:...:0001)
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // :: unspecified address — equivalent of 0.0.0.0
  if (h === "::" || h === "0:0:0:0:0:0:0:0") return true;
  // fc00::/7 unique-local (fc00::/8 and fd00::/8)
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  // fe80::/10 link-local
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  return false;
}

export function validateBackendUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    throw new Error(`Unsupported protocol "${u.protocol}" — only http(s) are allowed`);
  }

  // Production must use HTTPS. Exception: tunnel hosts (always external) and
  // local dev (NODE_ENV !== "production").
  const isProd = process.env.NODE_ENV === "production";
  if (proto === "http:" && isProd && !isTunnelHost(u.hostname)) {
    throw new Error(
      `Plaintext http:// URLs are not allowed in production (hostname: ${u.hostname}). Use HTTPS.`
    );
  }

  const host = u.hostname.toLowerCase();

  // Hostname blocklist
  if (host === "localhost" || host === "localhost.localdomain") {
    throw new Error(`Blocked hostname: "${host}" (localhost is not reachable from the server)`);
  }

  const ipv4 = parseIPv4(host);
  if (ipv4) {
    if (isPrivateIPv4(ipv4)) {
      throw new Error(
        `Blocked IP "${host}" — falls inside a reserved/private range (RFC1918, loopback, link-local, or 0.0.0.0)`
      );
    }
  } else if (isBlockedIPv6(host)) {
    throw new Error(`Blocked IPv6 "${host}" — loopback, unique-local, or link-local ranges are not permitted`);
  }
}
