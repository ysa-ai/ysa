/**
 * network-proxy.ts — Bun-based MITM proxy for sandbox network policy enforcement.
 *
 * Runs inside a hardened container on port 3128.
 * HTTP: inspects method + URL, allow/deny per policy.
 * HTTPS CONNECT: terminates TLS with dynamic certs signed by baked-in CA,
 *   inspects decrypted request, allow/deny per policy.
 *
 * Env: PROXY_POLICY (JSON) — defaults to strict policy.
 */

import { readFileSync, openSync, writeSync, closeSync, writeFileSync } from "fs";
import { createServer as createNetServer, Socket } from "net";
import { spawn } from "child_process";

const CA_CERT = readFileSync("/opt/proxy/ca.pem", "utf-8");
const CA_KEY = readFileSync("/opt/proxy/ca-key.pem", "utf-8");
const PORT = 3128;

// ── Policy ──────────────────────────────────────────────────────────────────

interface ScopedAllowRule {
  host: string;       // e.g. "api.example.com"
  pathPrefix: string; // e.g. "/v1/projects/my-project/"
}

interface StrictPolicy {
  allowedMethods: string[];
  blockBody: boolean;
  maxUrlLength: number;       // path + query combined
  maxHeaderBytes: number;
  rateLimitPerDomain: number; // req/min
  burstThreshold: number;     // max requests in 5s window
  outboundByteBudget: number; // bytes/min across URLs + headers
  globalRateLimitPerTask: number; // req/min across all domains for one task
  globalOutboundBudget: number;   // bytes/min across all domains for one task
  bypassHosts: string[];
  scopedAllowRules: ScopedAllowRule[]; // MCP tool hosts — allow all methods for specific project paths
}

// Non-provider-specific bypass hosts always allowed through the proxy.
// Entries may be "host" or "host:port" — port-qualified entries only match that specific port.
const BASE_BYPASS_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
];

// Check if hostname (+ optional port) matches a bypass list entry.
// Entry format: "host" (any port) or "host:port" (exact port required).
function isBypassHost(hosts: string[], hostname: string, port?: number): boolean {
  return hosts.some((entry) => {
    const lastColon = entry.lastIndexOf(":");
    if (lastColon > 0) {
      const entryPort = parseInt(entry.slice(lastColon + 1), 10);
      if (!isNaN(entryPort)) {
        const entryHost = entry.slice(0, lastColon);
        const hostMatch = hostname === entryHost || hostname.endsWith(`.${entryHost}`);
        return hostMatch && port === entryPort;
      }
    }
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

// Provider-specific bypass hosts come from PROXY_BYPASS_HOSTS env var (comma-separated)
// e.g. "api.anthropic.com,statsig.anthropic.com" for Claude
const providerBypassHosts = (process.env.PROXY_BYPASS_HOSTS || "api.anthropic.com,statsig.anthropic.com")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const DEFAULT_POLICY: StrictPolicy = {
  allowedMethods: ["GET"],
  blockBody: true,
  maxUrlLength: 200,
  maxHeaderBytes: 4096,
  rateLimitPerDomain: 30,
  burstThreshold: 10,
  outboundByteBudget: 51200, // 50KB/min
  globalRateLimitPerTask: 300,   // 10× per-domain; covers ≤10 legitimate domains at max rate
  globalOutboundBudget: 512000,  // 500 KB/min global cap
  bypassHosts: [...BASE_BYPASS_HOSTS, ...providerBypassHosts],
  scopedAllowRules: [],
};

const policy: StrictPolicy = (() => {
  try {
    const env = process.env.PROXY_POLICY;
    if (!env) return DEFAULT_POLICY;
    const parsed = JSON.parse(env);
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      // Merge arrays instead of replacing
      bypassHosts: [...DEFAULT_POLICY.bypassHosts, ...(parsed.bypassHosts || [])],
      scopedAllowRules: parsed.scopedAllowRules || [],
    };
  } catch {
    return DEFAULT_POLICY;
  }
})();

// ── Rate limiting / anomaly detection ───────────────────────────────────────

interface DomainCounters {
  minuteCount: number;
  minuteStart: number;
  burstCount: number;
  burstStart: number;
  outboundBytes: number;
  outboundStart: number;
}

const domainCounters = new Map<string, DomainCounters>();

setInterval(() => {
  const now = Date.now();
  for (const [key, c] of domainCounters) {
    if (now - c.minuteStart > 120_000 && now - c.burstStart > 120_000) {
      domainCounters.delete(key);
    }
  }
}, 60_000);

function getCounters(domain: string): DomainCounters {
  let c = domainCounters.get(domain);
  const now = Date.now();
  if (!c) {
    c = { minuteCount: 0, minuteStart: now, burstCount: 0, burstStart: now, outboundBytes: 0, outboundStart: now };
    domainCounters.set(domain, c);
    return c;
  }
  if (now - c.minuteStart > 60_000) {
    c.minuteCount = 0;
    c.minuteStart = now;
    c.outboundBytes = 0;
    c.outboundStart = now;
  }
  if (now - c.burstStart > 5_000) {
    c.burstCount = 0;
    c.burstStart = now;
  }
  return c;
}

// ── Global per-task counters ─────────────────────────────────────────────────

interface GlobalCounters {
  minuteCount: number;
  minuteStart: number;
  outboundBytes: number;
  outboundStart: number;
}

const globalCounters = new Map<string, GlobalCounters>();

setInterval(() => {
  const now = Date.now();
  for (const [key, g] of globalCounters) {
    if (now - g.minuteStart > 120_000) globalCounters.delete(key);
  }
}, 60_000);

function getGlobalCounters(taskKey: string): GlobalCounters {
  let g = globalCounters.get(taskKey);
  const now = Date.now();
  if (!g) {
    g = { minuteCount: 0, minuteStart: now, outboundBytes: 0, outboundStart: now };
    globalCounters.set(taskKey, g);
    return g;
  }
  if (now - g.minuteStart > 60_000) {
    g.minuteCount = 0; g.minuteStart = now;
    g.outboundBytes = 0; g.outboundStart = now;
  }
  return g;
}

// ── Counter persistence ──────────────────────────────────────────────────────

const STATE_FILE = "/var/proxy-state/counters.json";

function loadCounters(): void {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data.global ?? {})) globalCounters.set(k, v as GlobalCounters);
    for (const [k, v] of Object.entries(data.domain ?? {})) domainCounters.set(k, v as DomainCounters);
  } catch {}
}

function saveCounters(): void {
  try {
    const data = {
      global: Object.fromEntries(globalCounters),
      domain: Object.fromEntries(domainCounters),
    };
    writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (err: any) {
    console.error(`[proxy] saveCounters failed: ${err.message}`);
  }
}

function checkRateLimits(domain: string, pathLength: number, headerBytes: number, taskId: string): string | null {
  const key = `${taskId || "_shared"}:${domain}`;
  const c = getCounters(key);
  c.minuteCount++;
  c.burstCount++;
  c.outboundBytes += pathLength + headerBytes;

  if (c.minuteCount > policy.rateLimitPerDomain) {
    return `rate_limit: ${c.minuteCount}/${policy.rateLimitPerDomain} req/min for ${domain}`;
  }
  if (c.burstCount > policy.burstThreshold) {
    return `burst: ${c.burstCount} req in 5s for ${domain}`;
  }
  if (c.outboundBytes > policy.outboundByteBudget) {
    return `outbound_budget: ${c.outboundBytes}/${policy.outboundByteBudget} bytes/min for ${domain}`;
  }

  // Global limits — aggregate across all domains for this task
  const taskKey = taskId || "_shared";
  const g = getGlobalCounters(taskKey);
  const bytes = pathLength + headerBytes;
  g.minuteCount++;
  g.outboundBytes += bytes;
  if (g.minuteCount > policy.globalRateLimitPerTask)
    return `global_rate_limit: ${g.minuteCount}/${policy.globalRateLimitPerTask} req/min [task ${taskKey}]`;
  if (g.outboundBytes > policy.globalOutboundBudget)
    return `global_outbound_budget: ${g.outboundBytes}/${policy.globalOutboundBudget} bytes/min [task ${taskKey}]`;
  saveCounters();

  return null;
}

// ── Request inspection ──────────────────────────────────────────────────────

const STANDARD_HEADERS = new Set([
  "host", "user-agent", "accept", "accept-language", "accept-encoding",
  "connection", "cache-control", "pragma", "referer", "origin",
  "content-type", "content-length", "transfer-encoding",
  "authorization", "cookie", "if-modified-since", "if-none-match",
  "range", "te", "upgrade-insecure-requests",
]);

function inspectRequest(method: string, url: string, headers: Record<string, string>, hasBody: boolean, domain: string, taskId = ""): { allowed: boolean; reason: string } {
  // Parse URL early — needed for bypass port check and length/pattern checks
  let urlPart = url;
  let urlPort: number | undefined;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `http://${domain}${url}`);
    urlPart = parsed.pathname + parsed.search;
    if (parsed.port) urlPort = parseInt(parsed.port, 10);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }

  if (isBypassHost(policy.bypassHosts, domain, urlPort)) {
    return { allowed: true, reason: "bypass_host" };
  }

  // Scoped allow — matches host + URL path prefix, allows all methods (POST, PUT, etc.)
  for (const rule of policy.scopedAllowRules) {
    if ((domain === rule.host || domain.endsWith(`.${rule.host}`)) && urlPart.startsWith(rule.pathPrefix)) {
      return { allowed: true, reason: "scoped_allow" };
    }
  }

  // Method check
  if (!policy.allowedMethods.includes(method.toUpperCase())) {
    return { allowed: false, reason: `method_blocked: ${method}` };
  }

  // URL length check (path + query combined — blocks encoding in either)
  if (urlPart.length > policy.maxUrlLength) {
    return { allowed: false, reason: `url_too_long: ${urlPart.length}/${policy.maxUrlLength}` };
  }

  // Pattern detection on URL path segments — catches large encoded blobs in paths.
  // Strip query string first — only analyze the path, not query parameters.
  // URL-decode before checking so %2f-style encoding doesn't conceal patterns.
  // Re-split after decoding: encoded slashes (e.g. user%2Frepo) decode to multi-part strings.
  // Threshold at 48 chars: allows Git SHAs (40 hex), UUIDs (32 hex), long slugs, etc.
  const pathOnly = urlPart.split("?")[0];
  const segments = pathOnly.split("/").flatMap((s) => {
    try { return decodeURIComponent(s).split("/"); } catch { return [s]; }
  }).filter((s) => s.length > 48);
  for (const seg of segments) {
    if (/^[A-Za-z0-9+/=]+$/.test(seg)) {
      return { allowed: false, reason: `base64_pattern: "${seg.slice(0, 30)}..." (${seg.length} chars)` };
    }
    if (/^[0-9a-fA-F]+$/.test(seg)) {
      return { allowed: false, reason: `hex_pattern: "${seg.slice(0, 30)}..." (${seg.length} chars)` };
    }
  }

  // Body check
  if (policy.blockBody && hasBody) {
    return { allowed: false, reason: "body_blocked" };
  }

  // Header size check
  let headerSize = 0;
  for (const [key, value] of Object.entries(headers)) {
    headerSize += key.length + (value?.length ?? 0);
  }
  if (headerSize > policy.maxHeaderBytes) {
    return { allowed: false, reason: `headers_too_large: ${headerSize}/${policy.maxHeaderBytes}` };
  }

  // Rate limits + outbound byte budget
  const rateResult = checkRateLimits(domain, urlPart.length, headerSize, taskId);
  if (rateResult) {
    return { allowed: false, reason: rateResult };
  }

  return { allowed: true, reason: "allowed" };
}

function extractTaskId(headers: Record<string, string>): string {
  const auth = headers["proxy-authorization"] ?? "";
  if (!auth.startsWith("Basic ")) return "";
  try {
    const decoded = atob(auth.slice(6));
    const user = decoded.split(":")[0] ?? "";
    return user;
  } catch {
    return "";
  }
}

const LOG_DIR = "/proxy-logs";

function appendToTaskLog(taskId: string, line: string) {
  try {
    const fd = openSync(`${LOG_DIR}/${taskId}.log`, "a", 0o600);
    writeSync(fd, line);
    closeSync(fd);
  } catch {}
}

function log(action: "ALLOW" | "BLOCK", method: string, target: string, reason: string, taskId?: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${action}] ${method} ${target} ${reason}\n`;
  if (taskId) {
    appendToTaskLog(taskId, line);
  } else {
    console.log(line.trimEnd());
  }
}

// ── Dynamic cert generation ─────────────────────────────────────────────────

const certCache = new Map<string, { cert: string; key: string }>();

function generateCertForHost(hostname: string): Promise<{ cert: string; key: string }> {
  const cached = certCache.get(hostname);
  if (cached) return Promise.resolve(cached);

  const id = Math.random().toString(36).slice(2, 10);
  const keyFile = `/tmp/cert-${id}.key`;
  const csrFile = `/tmp/cert-${id}.csr`;
  const certFile = `/tmp/cert-${id}.crt`;

  const script = [
    `openssl ecparam -genkey -name prime256v1 -noout -out ${keyFile}`,
    `openssl req -new -key ${keyFile} -subj "/CN=${hostname}" -addext "subjectAltName=DNS:${hostname}" -out ${csrFile}`,
    `openssl x509 -req -in ${csrFile} -CA /opt/proxy/ca.pem -CAkey /opt/proxy/ca-key.pem -CAserial /tmp/ca.srl -CAcreateserial -days 1 -copy_extensions copyall -out ${certFile}`,
  ].join(" && ");

  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      try {
        if (code !== 0) {
          spawn("sh", ["-c", `rm -f ${keyFile} ${csrFile} ${certFile}`]);
          return reject(new Error(`cert generation failed (exit ${code}): ${stderr}`));
        }
        const keyPem = readFileSync(keyFile, "utf-8");
        const certPem = readFileSync(certFile, "utf-8");
        spawn("sh", ["-c", `rm -f ${keyFile} ${csrFile} ${certFile}`]);
        const result = { cert: certPem, key: keyPem };
        certCache.set(hostname, result);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ── Strip non-standard headers ──────────────────────────────────────────────

function stripNonStandardHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STANDARD_HEADERS.has(key.toLowerCase())) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ── Parse HTTP request line + headers from raw bytes ────────────────────────

function parseHttpHeaders(buf: Buffer): { method: string; path: string; headers: Record<string, string>; headerEndIndex: number } | null {
  const str = buf.toString("utf-8");
  const headerEnd = str.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerSection = str.slice(0, headerEnd);
  const lines = headerSection.split("\r\n");
  const parts = (lines[0] ?? "").split(" ");
  const method = parts[0] ?? "GET";
  const path = parts[1] ?? "/";

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      headers[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i].slice(colonIdx + 1).trim();
    }
  }

  return { method, path, headers, headerEndIndex: headerEnd + 4 };
}

// ── HTTP request handler (plain HTTP proxy) ─────────────────────────────────

function handleHttpRequest(clientSocket: Socket, data: Buffer) {
  const parsed = parseHttpHeaders(data);
  if (!parsed) {
    clientSocket.destroy();
    return;
  }

  const { method, path: url } = parsed;
  const taskId = extractTaskId(parsed.headers);
  let domain = "";
  let logTarget = url;
  try {
    const p = new URL(url);
    domain = p.hostname;
    logTarget = `${p.hostname}${p.pathname}${p.search}`;
  } catch {
    domain = (parsed.headers["host"] ?? "").split(":")[0];
    logTarget = `${domain}${url}`;
  }

  const hasBody = (parseInt(parsed.headers["content-length"] ?? "0") > 0) ||
    parsed.headers["transfer-encoding"] === "chunked";
  const cleanHeaders = stripNonStandardHeaders(parsed.headers);
  const result = inspectRequest(method, url, cleanHeaders, hasBody, domain, taskId);

  if (!result.allowed) {
    log("BLOCK", method, logTarget, result.reason, taskId);
    clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by network policy: ${result.reason}\n`);
    clientSocket.destroy();
    return;
  }

  log("ALLOW", method, logTarget, result.reason, taskId);

  // Forward to upstream
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstreamPort = parseInt(parsedUrl.port) || 80;
  const upstream = new Socket();
  // Force connection close so each HTTP request requires a new TCP connection.
  // Without this, keep-alive connections pipe subsequent requests directly,
  // bypassing handleHttpRequest and all policy/rate-limit checks entirely.
  cleanHeaders["connection"] = "close";
  upstream.connect(upstreamPort, parsedUrl.hostname, () => {
    // Rewrite the request line to use path-only (not absolute URL)
    const reqLine = `${method} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\r\n`;
    const headerLines = Object.entries(cleanHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    const bodyPart = data.slice(parsed.headerEndIndex);
    upstream.write(`${reqLine}${headerLines}\r\n\r\n`);
    if (bodyPart.length > 0) upstream.write(bodyPart);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  upstream.on("error", (err) => {
    log("BLOCK", method, logTarget, `upstream_error: ${err.message}`, taskId);
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy error: ${err.message}\n`);
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
}

// ── HTTPS CONNECT handler ───────────────────────────────────────────────────

async function createMitmConnection(
  clientSocket: Socket,
  hostname: string,
  upstreamPort: number,
  taskId: string,
): Promise<void> {
  let hostCert: { cert: string; key: string };
  try {
    hostCert = await generateCertForHost(hostname);
  } catch (err: any) {
    log("BLOCK", "CONNECT", `${hostname}:${upstreamPort}`, `mitm_error: ${err.message}`, taskId);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const mitmServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: hostCert.cert, key: hostCert.key },
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname + url.search;
      const fullUrl = `https://${hostname}${path}`;

      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const cleanHeaders = stripNonStandardHeaders(headers);

      const hasBody = (parseInt(headers["content-length"] ?? "0") > 0) ||
        headers["transfer-encoding"] === "chunked";

      // taskId is captured in closure — always correct for this connection
      const result = inspectRequest(method, fullUrl, cleanHeaders, hasBody, hostname, taskId);

      if (!result.allowed) {
        log("BLOCK", method, `${hostname}${path}`, result.reason, taskId);
        return new Response(`Blocked by network policy: ${result.reason}\n`, { status: 403 });
      }

      log("ALLOW", method, `${hostname}${path}`, result.reason, taskId);

      // Forward to actual upstream
      try {
        const upstreamUrl = `https://${hostname}:${upstreamPort}${path}`;
        const forwardHeaders = new Headers();
        for (const [k, v] of Object.entries(cleanHeaders)) {
          if (k !== "host") forwardHeaders.set(k, v);
        }
        forwardHeaders.set("host", hostname);

        const upstreamResp = await fetch(upstreamUrl, {
          method,
          headers: forwardHeaders,
          body: hasBody ? req.body : undefined,
          redirect: "manual",
        });

        // Track response bytes against global budget (best-effort: Content-Length only)
        const respLen = parseInt(upstreamResp.headers.get("content-length") ?? "0", 10);
        if (!isNaN(respLen) && respLen > 0) {
          const g = getGlobalCounters(taskId || "_shared");
          g.outboundBytes += respLen;
          saveCounters();
        }

        // Bun's fetch auto-decompresses the body but keeps Content-Encoding.
        // Strip it so the client doesn't try to decompress again.
        const respHeaders = new Headers(upstreamResp.headers);
        respHeaders.delete("content-encoding");
        respHeaders.delete("content-length");

        return new Response(upstreamResp.body, {
          status: upstreamResp.status,
          statusText: upstreamResp.statusText,
          headers: respHeaders,
        });
      } catch (err: any) {
        log("BLOCK", method, `${hostname}${path}`, `upstream_error: ${err.message}`, taskId);
        return new Response(`Proxy error: ${err.message}\n`, { status: 502 });
      }
    },
  });

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const localConn = new Socket();
  localConn.connect(mitmServer.port, "127.0.0.1", () => {
    localConn.pipe(clientSocket);
    clientSocket.pipe(localConn);
  });

  const cleanup = () => { try { mitmServer.stop(true); } catch {} };
  localConn.on("close", cleanup);
  clientSocket.on("close", cleanup);
  localConn.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => localConn.destroy());
}

async function handleConnect(clientSocket: Socket, hostname: string, upstreamPort: number, taskId: string) {
  // Bypass hosts — tunnel directly without MITM
  if (isBypassHost(policy.bypassHosts, hostname, upstreamPort)) {
    log("ALLOW", "CONNECT", `${hostname}:${upstreamPort}`, "bypass_host", taskId);
    const upstream = new Socket();
    upstream.connect(upstreamPort, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    return;
  }

  // Create a per-connection MITM server with taskId captured in closure
  await createMitmConnection(clientSocket, hostname, upstreamPort, taskId);
}

// ── Main server (raw TCP) ───────────────────────────────────────────────────
// We use a raw TCP server so we can handle both HTTP and CONNECT in one place.

const server = createNetServer((clientSocket: Socket) => {
  let buffer = Buffer.alloc(0);
  let handled = false;

  const onData = (chunk: Buffer) => {
    if (handled) return;
    buffer = Buffer.concat([buffer, chunk]);

    const str = buffer.toString("utf-8");
    const firstLineEnd = str.indexOf("\r\n");
    if (firstLineEnd === -1) return; // Wait for full first line

    const firstLine = str.slice(0, firstLineEnd);
    const parts = firstLine.split(" ");

    if (parts[0] === "CONNECT") {
      // HTTPS CONNECT — need full headers before handling
      const headerEnd = str.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      handled = true;
      clientSocket.removeListener("data", onData);

      // Parse headers to extract task ID from Proxy-Authorization
      const connectHeaders: Record<string, string> = {};
      const headerLines = str.slice(0, headerEnd).split("\r\n");
      for (let i = 1; i < headerLines.length; i++) {
        const colonIdx = headerLines[i].indexOf(":");
        if (colonIdx > 0) {
          connectHeaders[headerLines[i].slice(0, colonIdx).trim().toLowerCase()] = headerLines[i].slice(colonIdx + 1).trim();
        }
      }
      const taskId = extractTaskId(connectHeaders);

      const [hostname, portStr] = (parts[1] ?? "").split(":");
      const port = parseInt(portStr) || 443;
      handleConnect(clientSocket, hostname, port, taskId);
    } else {
      // HTTP request — need full headers before handling
      const headerEnd = str.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      handled = true;
      clientSocket.removeListener("data", onData);
      handleHttpRequest(clientSocket, buffer);
    }
  };

  clientSocket.on("data", onData);
  clientSocket.on("error", () => {});
});

loadCounters();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] Network proxy listening on port ${PORT}`);
  console.log(`[proxy] Policy: ${JSON.stringify(policy)}`);
});

process.on("SIGTERM", () => { console.log("[proxy] Shutting down..."); server.close(); process.exit(0); });
process.on("SIGINT", () => { console.log("[proxy] Shutting down..."); server.close(); process.exit(0); });
