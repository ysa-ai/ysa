import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import type { ProviderAdapter, CommandOpts, ParsedOutput, ContainerConfig, ProviderModel, ParsedLogEntry } from "./types";

// ── Models ────────────────────────────────────────────────────────────────────

const CLAUDE_MODELS: ProviderModel[] = [
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", isDefault: true },
  { id: "claude-sonnet-4-5", name: "Sonnet 4.5", isDefault: false },
  { id: "claude-opus-4-6", name: "Opus 4.6", isDefault: false },
];

// ── Auth ──────────────────────────────────────────────────────────────────────
// OAuth flow for Claude Code — reads from macOS Keychain or ANTHROPIC_API_KEY env var.
// These functions use Bun.spawn and are server-side only.

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

let cachedOAuthToken: string | null = null;
let cachedTokenExpiresAt = 0;
let cachedClientId: string | null = null;

async function extractClientIdFromBinary(): Promise<string | null> {
  if (cachedClientId) return cachedClientId;
  try {
    const which = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    const whichOut = (await new Response(which.stdout).text()).trim();
    if ((await which.exited) !== 0 || !whichOut) return null;

    const readlink = Bun.spawn(["readlink", "-f", whichOut], { stdout: "pipe", stderr: "pipe" });
    const binPath = (await new Response(readlink.stdout).text()).trim();
    if ((await readlink.exited) !== 0 || !binPath) return null;

    const extract = Bun.spawn(
      ["bash", "-c", `grep -oaE 'CLIENT_ID:"[0-9a-f-]+"' "${binPath}" 2>/dev/null | head -1 | sed 's/CLIENT_ID:"//;s/"//'`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const clientId = (await new Response(extract.stdout).text()).trim();
    if ((await extract.exited) !== 0 || !clientId) return null;

    cachedClientId = clientId;
    return clientId;
  } catch {
    return null;
  }
}

async function readCredentials(): Promise<Record<string, any>> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !stdout.trim()) {
      throw new Error(
        "Failed to read Claude OAuth token from macOS Keychain. Run 'claude /login' first.",
      );
    }

    return JSON.parse(stdout.trim());
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
      ["security", "add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", "", "-w", json],
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

async function refreshOAuthToken(refreshToken: string, clientId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
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
    if (parsed?.error === "invalid_grant") {
      throw new Error("invalid_grant");
    }
    throw new Error(`OAuth refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
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

  if (needsRefresh) {
    if (!oauth.refreshToken) {
      throw new Error("OAuth token expired and no refresh token available. Run 'claude /login'.");
    }

    const clientId = await extractClientIdFromBinary() ?? process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
    if (!clientId) {
      throw new Error("OAuth token expired and could not be refreshed. Run 'claude /login' to re-authenticate, or set the CLAUDE_CODE_OAUTH_CLIENT_ID env var.");
    }
    console.log("[oauth] Access token expired or expiring soon, refreshing...");
    let refreshed: Awaited<ReturnType<typeof refreshOAuthToken>>;
    try {
      refreshed = await refreshOAuthToken(oauth.refreshToken, clientId);
    } catch (err: any) {
      if (err.message === "invalid_grant") {
        // Refresh token was rotated by Claude CLI — re-read Keychain and retry once
        const freshCreds = await readCredentials();
        const freshOAuth = freshCreds.claudeAiOauth;
        if (freshOAuth?.refreshToken && freshOAuth.refreshToken !== oauth.refreshToken) {
          console.log("[oauth] Refresh token rotated by Claude CLI, retrying with fresh token...");
          refreshed = await refreshOAuthToken(freshOAuth.refreshToken, clientId);
          Object.assign(creds, freshCreds);
          Object.assign(oauth, freshOAuth);
        } else {
          cachedOAuthToken = null;
          cachedTokenExpiresAt = 0;
          throw new Error("Claude session expired. Run 'claude /login' to re-authenticate.");
        }
      } else {
        throw err;
      }
    }

    creds.claudeAiOauth = {
      ...oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
    };
    await writeCredentials(creds);

    cachedOAuthToken = refreshed.accessToken;
    cachedTokenExpiresAt = Date.now() + refreshed.expiresIn * 1000;
    console.log(`[oauth] Token refreshed, expires in ${(refreshed.expiresIn / 3600).toFixed(1)}h`);
  } else {
    cachedOAuthToken = oauth.accessToken;
    cachedTokenExpiresAt = expiresAt;
  }

  return cachedOAuthToken!;
}

async function getClaudeAuthEnv(): Promise<Record<string, string>> {
  const { getConfig } = await import("../api/config-store");
  const apiKey = getConfig().anthropic_api_key;
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

    try {
      const parsed = JSON.parse(line);

      if (parsed.type === "system" && parsed.session_id) {
        sessionId = parsed.session_id;
      }

      if (parsed.type === "result" && parsed.subtype === "error_max_turns") {
        maxTurnsReached = true;
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
    } catch {
      // Not JSON — skip
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

  if (opts.resumeSessionId) {
    args.push(
      "--resume", opts.resumeSessionId,
      "-p", opts.resumePrompt ?? "Continue from where you left off. Complete the remaining tasks.",
    );
  } else if (!opts.usePromptUrl && opts.prompt) {
    args.push("-p", opts.prompt);
  }

  if (opts.allowedTools) {
    args.push("--allowedTools", opts.allowedTools);
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
