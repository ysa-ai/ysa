import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir, userInfo } from "os";
import type { ProviderAdapter, CommandOpts, ParsedOutput, ContainerConfig, ProviderModel, ParsedLogEntry } from "./types";

// ── Models ────────────────────────────────────────────────────────────────────

const CLAUDE_MODELS: ProviderModel[] = [
  { id: "claude-opus-4-8", name: "Opus 4.8", isDefault: false },
  { id: "claude-opus-4-7", name: "Opus 4.7", isDefault: false },
  { id: "claude-opus-4-6", name: "Opus 4.6", isDefault: false },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", isDefault: true },
  { id: "claude-sonnet-4-5", name: "Sonnet 4.5", isDefault: false },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", isDefault: false },
  { id: "claude-fable-5", name: "Fable 5", isDefault: false },
];

// ── Auth ──────────────────────────────────────────────────────────────────────
// OAuth flow for Claude Code — reads from macOS Keychain or ANTHROPIC_API_KEY env var.
// These functions use Bun.spawn and are server-side only.

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

let cachedOAuthToken: string | null = null;
let cachedTokenExpiresAt = 0;
let cachedClientId: string | null = null;

// Local dev placeholder baked into the binary — never a valid prod client.
const DEV_PLACEHOLDER_CLIENT_ID = "00000000-0000-4000-8000-000000000000";

// Returns every plausible OAuth client ID embedded in the claude binary, ordered
// with the one tagged OAUTH_FILE_SUFFIX:"" first (the historical "prod" heuristic),
// then any remaining IDs. The marker is not reliable across CLI versions, so we
// keep all candidates and let the refresh path try each until one is accepted.
async function extractClientIdsFromBinary(): Promise<string[]> {
  try {
    const which = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    const whichOut = (await new Response(which.stdout).text()).trim();
    if ((await which.exited) !== 0 || !whichOut) return [];

    const readlink = Bun.spawn(["readlink", "-f", whichOut], { stdout: "pipe", stderr: "pipe" });
    const binPath = (await new Response(readlink.stdout).text()).trim();
    if ((await readlink.exited) !== 0 || !binPath) return [];

    const preferred = (await runGrep(`grep -oaE 'CLIENT_ID:"[0-9a-f-]+",OAUTH_FILE_SUFFIX:""' "${binPath}" 2>/dev/null | grep -oE '[0-9a-f-]{36}'`));
    const all = (await runGrep(`grep -oaE 'CLIENT_ID:"[0-9a-f-]+"' "${binPath}" 2>/dev/null | grep -oE '[0-9a-f-]{36}'`));

    const ordered: string[] = [];
    for (const id of [...preferred, ...all]) {
      if (id === DEV_PLACEHOLDER_CLIENT_ID) continue;
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  } catch {
    return [];
  }
}

async function runGrep(cmd: string): Promise<string[]> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

async function readCredentials(): Promise<Record<string, any>> {
  if (process.platform === "darwin") {
    // Prefer the username-keyed entry — that's the item the current Claude CLI
    // (`claude /login`) reads and writes. An older/stale unnamed ("") entry must
    // never shadow it, or the agent reads a revoked token that `claude /login`
    // never refreshes. Mirrors shared/src/providers/claude.ts — keep in sync.
    const account = userInfo().username;
    const cmds = [
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"],
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ];

    for (const cmd of cmds) {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0 || !stdout.trim()) continue;
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.claudeAiOauth?.accessToken) return parsed;
      } catch { continue; }
    }

    throw new Error(
      "Failed to read Claude OAuth token from macOS Keychain. Run 'claude /login' first.",
    );
  } else {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    try {
      const raw = await readFile(credPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      throw new Error(
        "No credentials found. Run 'claude /login' to authenticate.",
      );
    }
  }
}

async function writeCredentials(creds: Record<string, any>): Promise<void> {
  if (process.platform === "darwin") {
    const json = JSON.stringify(creds);
    const proc = Bun.spawn(
      ["security", "add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w", json],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("[oauth] Failed to update Keychain:", stderr);
    }
  } else {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    await mkdir(dirname(credPath), { recursive: true });
    await writeFile(credPath, JSON.stringify(creds), { mode: 0o600 });
  }
}

type RefreshOutcome =
  | { kind: "success"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "invalid_grant" }      // refresh token not valid for this client (or revoked)
  | { kind: "client_not_found" }   // this client_id is unknown to the OAuth server
  | { kind: "error"; detail: string };

export async function refreshOAuthToken(refreshToken: string, clientId: string): Promise<RefreshOutcome> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    if (parsed?.error === "invalid_grant") return { kind: "invalid_grant" };
    if (parsed?.error?.type === "invalid_request_error") return { kind: "client_not_found" };
    return { kind: "error", detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    kind: "success",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

type RefreshAllResult =
  | { ok: true; clientId: string; tokens: { accessToken: string; refreshToken: string; expiresIn: number } }
  | { ok: false; attempts: { clientId: string; reason: string }[] };

// Try the refresh against each candidate client ID until one is accepted. Failed
// attempts (invalid_grant / client_not_found) do NOT consume the refresh token —
// only a successful refresh rotates it — so iterating is safe.
export async function refreshWithCandidates(refreshToken: string, clientIds: string[]): Promise<RefreshAllResult> {
  const attempts: { clientId: string; reason: string }[] = [];
  for (const clientId of clientIds) {
    const outcome = await refreshOAuthToken(refreshToken, clientId);
    if (outcome.kind === "success") {
      return { ok: true, clientId, tokens: outcome };
    }
    const reason = outcome.kind === "error" ? outcome.detail : outcome.kind;
    attempts.push({ clientId, reason });
    console.log(`[oauth] refresh with client ${clientId.slice(0, 8)}… → ${reason}`);
  }
  return { ok: false, attempts };
}

async function getOAuthToken(): Promise<string> {
  if (cachedOAuthToken && Date.now() < cachedTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedOAuthToken;
  }

  const creds = await readCredentials();
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error("No accessToken in Keychain credentials. Run 'claude /login' first.");
  }

  const expiresAt = oauth.expiresAt || 0;
  const needsRefresh = Date.now() >= expiresAt - TOKEN_REFRESH_MARGIN_MS;

  if (!needsRefresh) {
    cachedOAuthToken = oauth.accessToken;
    cachedTokenExpiresAt = expiresAt;
    return oauth.accessToken;
  }

  if (!oauth.refreshToken) {
    throw new Error("OAuth token expired and no refresh token available. Run 'claude /login'.");
  }

  // Build candidate client IDs: the previously-successful one first (fast path),
  // then an explicit env override, then every ID found in the claude binary. The
  // OAUTH_FILE_SUFFIX:"" marker is not a reliable "prod" indicator across CLI
  // versions, so we try each candidate rather than committing to one.
  const candidates: string[] = [];
  const push = (id?: string | null) => { if (id && !candidates.includes(id)) candidates.push(id); };
  push(cachedClientId);
  push(process.env.CLAUDE_CODE_OAUTH_CLIENT_ID);
  for (const id of await extractClientIdsFromBinary()) push(id);

  if (candidates.length === 0) {
    throw new Error("OAuth token expired and no client ID could be determined (claude binary not found). Run 'claude /login', or set CLAUDE_CODE_OAUTH_CLIENT_ID.");
  }

  console.log(`[oauth] Access token expired or expiring soon, refreshing (trying ${candidates.length} client ID(s))...`);
  let result = await refreshWithCandidates(oauth.refreshToken, candidates);

  // The Claude CLI may have rotated the refresh token under us — re-read once and retry.
  if (!result.ok) {
    const freshCreds = await readCredentials();
    const freshRt = freshCreds.claudeAiOauth?.refreshToken;
    if (freshRt && freshRt !== oauth.refreshToken) {
      console.log("[oauth] Refresh token rotated by Claude CLI, retrying with fresh token...");
      result = await refreshWithCandidates(freshRt, candidates);
      if (result.ok) {
        Object.assign(creds, freshCreds);
        Object.assign(oauth, freshCreds.claudeAiOauth);
      }
    }
  }

  if (!result.ok) {
    cachedOAuthToken = null;
    cachedTokenExpiresAt = 0;
    cachedClientId = null;
    const summary = result.attempts.map((a) => `${a.clientId.slice(0, 8)}…=${a.reason}`).join(", ");
    const allInvalidGrant = result.attempts.every((a) => a.reason === "invalid_grant");
    if (allInvalidGrant) {
      throw new Error(`Claude session expired — refresh token rejected (invalid_grant) by all ${result.attempts.length} client ID(s). Run 'claude /login' to re-authenticate. [${summary}]`);
    }
    throw new Error(`Claude OAuth refresh failed for all client IDs. Update the Claude CLI and run 'claude /login', or set CLAUDE_CODE_OAUTH_CLIENT_ID. [${summary}]`);
  }

  // Cache the client ID that worked so future refreshes skip the candidate loop.
  cachedClientId = result.clientId;
  const tokens = result.tokens;
  creds.claudeAiOauth = {
    ...oauth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
  await writeCredentials(creds);

  cachedOAuthToken = tokens.accessToken;
  cachedTokenExpiresAt = Date.now() + tokens.expiresIn * 1000;
  console.log(`[oauth] Token refreshed via client ${result.clientId.slice(0, 8)}…, expires in ${(tokens.expiresIn / 3600).toFixed(1)}h`);
  return tokens.accessToken;
}

async function getClaudeAuthEnv(): Promise<Record<string, string>> {
  const { getApiKey } = await import("../cli/keystore");
  const apiKey = await getApiKey("anthropic");
  if (apiKey) {
    return { ANTHROPIC_API_KEY: apiKey };
  }
  const oauthToken = await getOAuthToken();
  return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
}

// ── Log parsing ───────────────────────────────────────────────────────────────

function parseClaudeLogLine(rawLine: string): ParsedLogEntry | null {
  if (!rawLine.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (obj.type === "system" && obj.subtype === "progress") {
    return {
      type: "progress",
      icon: "progress",
      text: obj.message || "Working...",
    };
  }

  if (obj.type === "system" && obj.subtype === "init") {
    return {
      type: "system",
      icon: "init",
      text: `Session started — model: ${obj.model}, tools: ${obj.tools?.length || 0}`,
      session_id: obj.session_id,
    };
  }

  if (obj.type === "assistant" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        return { type: "assistant", icon: "message", text: block.text.trim() };
      }
      if (block.type === "tool_use") {
        const input = block.input || {};
        let detail = "";
        if (block.name === "Read" || block.name === "Write" || block.name === "Edit") {
          detail = input.file_path || "";
        } else if (block.name === "Bash") {
          detail = input.command || "";
        } else if (block.name === "Glob") {
          detail = input.pattern || "";
        } else if (block.name === "Grep") {
          detail = input.pattern || "";
        } else {
          detail = JSON.stringify(input);
        }
        return {
          type: "tool_call",
          icon: "tool",
          tool: block.name,
          text: detail,
          tool_use_id: block.id,
        };
      }
    }
  }

  if (obj.type === "user" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        let content = "";
        if (typeof block.content === "string") {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = block.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }
        if (content.length > 10000) content = "…" + content.slice(-10000);
        return { type: "raw", icon: "tool_result", text: content, tool_use_id: block.tool_use_id };
      }
    }
  }

  if (obj.type === "result") {
    return {
      type: "result",
      icon: obj.subtype === "success" ? "success" : "error",
      text:
        obj.result?.slice(0, 300) ||
        `${obj.subtype} — ${obj.num_turns || "?"} turns, cost: $${obj.total_cost_usd?.toFixed(4) || "?"}`,
      cost: obj.total_cost_usd,
      turns: obj.num_turns,
    };
  }

  return null;
}

// ── Output parsing ────────────────────────────────────────────────────────────

function parseClaudeOutput(logContent: string, skipLinesBefore = 0): ParsedOutput {
  const lines = logContent.split("\n");
  const relevantLines = skipLinesBefore > 0 ? lines.slice(skipLinesBefore) : lines;

  let sessionId: string | null = null;
  let maxTurnsReached = false;
  let agentAborted = false;
  let abortReason: string | null = null;
  let lastError: string | null = null;

  for (const line of relevantLines) {
    if (!line.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON — Claude CLI may emit plain-text errors (e.g. auth failures)
      lastError = line.trim().slice(0, 300);
      continue;
    }

    if (parsed.type === "system" && parsed.session_id) {
      sessionId = parsed.session_id;
    }

    if (parsed.type === "result" && parsed.subtype === "error_max_turns") {
      maxTurnsReached = true;
    }

    if (parsed.type === "result" && parsed.subtype === "success") {
      lastError = null;
    }

    // JSON error objects (e.g. {"type":"error","message":"..."})
    if (parsed.type === "error" && parsed.message) {
      lastError = String(parsed.message).slice(0, 300);
    }

    if (parsed.type === "assistant" && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === "text" && block.text) {
          lastError = block.text.slice(0, 200);
          const abortMatch = block.text.match(/\[TASK_ABORTED\]:\s*(.*)/);
          if (abortMatch) {
            agentAborted = true;
            abortReason = abortMatch[1].trim().slice(0, 200);
          }
        }
      }
    }
  }

  // Also check all lines for session_id (it may appear before skipLinesBefore)
  if (!sessionId) {
    for (const line of lines) {
      const match = line.match(/"session_id":"([^"]*)"/);
      if (match) sessionId = match[1];
    }
  }

  return { sessionId, maxTurnsReached, agentAborted, abortReason, lastError };
}

function extractClaudeSessionId(logContent: string): string | null {
  const matches = logContent.match(/"session_id":"([^"]*)"/g);
  if (!matches) return null;
  const last = matches[matches.length - 1];
  return last.match(/"session_id":"([^"]*)"/)?.[1] ?? null;
}

// ── Container init script ─────────────────────────────────────────────────────

const CLAUDE_INIT_SCRIPT = `
if [ ! -f /home/agent/.claude/settings.json ] && [ -f /etc/claude-defaults/settings.json ]; then
  mkdir -p /home/agent/.claude/hooks
  cp /etc/claude-defaults/settings.json /home/agent/.claude/settings.json
  cp /etc/claude-defaults/hooks/sandbox-guard.sh /home/agent/.claude/hooks/sandbox-guard.sh 2>/dev/null
  chmod +x /home/agent/.claude/hooks/sandbox-guard.sh 2>/dev/null
fi
if [ -n "\${ALLOWED_TOOLS:-}" ] && [ -f /home/agent/.claude/settings.json ]; then
  TOOLS_JSON=\$(echo "\$ALLOWED_TOOLS" | tr ',' '\\n' | jq -R . | jq -s . 2>/dev/null || echo '[]')
  if [ "\$TOOLS_JSON" != '[]' ]; then
    jq --argjson t "\$TOOLS_JSON" '.permissions.allow = \$t' /home/agent/.claude/settings.json > /tmp/s.json 2>/dev/null && mv /tmp/s.json /home/agent/.claude/settings.json
  fi
fi
if [ -f /home/agent/.claude.json ]; then
  jq '.hasCompletedOnboarding = true | .projects["/workspace"].hasTrustDialogAccepted = true' /home/agent/.claude.json > /tmp/cj.json 2>/dev/null && mv /tmp/cj.json /home/agent/.claude.json
else
  echo '{"hasCompletedOnboarding":true,"projects":{"/workspace":{"hasTrustDialogAccepted":true}}}' > /home/agent/.claude.json
fi
`.trim();

// ── Command builder ───────────────────────────────────────────────────────────

function buildClaudeCommand(opts: CommandOpts): string[] {
  const args: string[] = [];

  if (opts.interactive) {
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    args.push("--add-dir", "/workspace", "--dangerously-skip-permissions");
    return args;
  }

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
    if (!opts.usePromptUrl) {
      args.push("-p", opts.resumePrompt ?? "Continue from where you left off. Complete the remaining tasks.");
    }
  } else if (!opts.usePromptUrl && opts.prompt) {
    args.push("-p", opts.prompt);
  }

  if (opts.allowedTools) {
    const tools = opts.allowedTools.split(",").filter((t) => t !== "mcp__*").join(",");
    if (tools) args.push("--tools", tools);
    if (!opts.allowedTools.includes("mcp__")) {
      args.push("--strict-mcp-config");
    }
  } else {
    args.push("--strict-mcp-config");
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  args.push(
    "--add-dir", "/workspace",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns", String(opts.maxTurns ?? 60),
  );

  return args;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  name: "Claude Code",
  agentBinary: "claude",
  models: CLAUDE_MODELS,

  authEnvKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  getAuthEnv: getClaudeAuthEnv,

  buildCommand: buildClaudeCommand,

  parseLogLine: parseClaudeLogLine,
  parseOutput: parseClaudeOutput,
  extractSessionId: extractClaudeSessionId,

  containerImage: "sandbox-claude",
  packageManager: "apt",
  bypassHosts: ["api.anthropic.com", "statsig.anthropic.com"],

  initContainerConfig(_opts?: { model?: string }): ContainerConfig {
    return {
      initScript: CLAUDE_INIT_SCRIPT,
      envVars: {},
    };
  },

  capabilities: {
    sessionResume: true,
    maxTurns: true,
    toolRestriction: true,
    hooks: true,
    streamingOutput: true,
    maxPrice: false,
  },

  mapToolNames(tools: string[]): string[] {
    return tools;
  },
};
