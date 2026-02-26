import type { ProviderAdapter, CommandOpts, ParsedOutput, ContainerConfig, ProviderModel, ParsedLogEntry } from "./types";

// ── Models ────────────────────────────────────────────────────────────────────

const MISTRAL_MODELS: ProviderModel[] = [
  { id: "devstral-2", name: "Devstral 2", isDefault: true },
  { id: "mistral-large-latest", name: "Mistral Large 3", isDefault: false },
  { id: "mistral-medium-latest", name: "Mistral Medium 3.1", isDefault: false },
  { id: "devstral-small-latest", name: "Devstral Small", isDefault: false },
  { id: "codestral-latest", name: "Codestral", isDefault: false },
];

// ── Tool name mapping ─────────────────────────────────────────────────────────
// Maps Claude tool names → Mistral Vibe --enabled-tools names

const TOOL_MAP: Record<string, string> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "search_replace",
  Grep: "grep",
  Bash: "bash",
  // Glob, WebSearch, WebFetch have no Vibe equivalent — omitted
};

const VIBE_TOOL_NAMES = new Set(Object.values(TOOL_MAP));

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getMistralAuthEnv(): Promise<Record<string, string>> {
  const { getConfig } = await import("../api/config-store");
  const apiKey = getConfig().mistral_api_key;
  if (!apiKey) {
    throw new Error("Mistral API key is not configured. Set it in Settings.");
  }
  return { MISTRAL_API_KEY: apiKey };
}

// ── Log parsing ───────────────────────────────────────────────────────────────
// Parses NDJSON from `vibe --output streaming`

function parseMistralLogLine(rawLine: string): ParsedLogEntry | null {
  if (!rawLine.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (obj.type === "progress" || (obj.type === "system" && obj.subtype === "progress")) {
    return {
      type: "progress",
      icon: "progress",
      text: obj.message || "Working...",
    };
  }

  if (obj.role === "system" || obj.role === "user" || obj.role === "tool") return null;

  if (obj.role === "assistant") {
    // Tool calls take priority — show the first one
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      const call = obj.tool_calls[0];
      // vibe uses call.function.name / call.function.arguments (JSON string)
      const name = call.function?.name ?? call.name ?? "unknown";
      const rawArgs = call.function?.arguments ?? call.input ?? call.arguments ?? {};
      const input = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      let detail = "";
      if (name === "read_file" || name === "write_file") {
        detail = input.path ?? input.file_path ?? "";
      } else if (name === "bash") {
        detail = input.command ?? input.cmd ?? "";
      } else if (name === "grep" || name === "search_replace") {
        detail = input.pattern ?? input.old_str ?? "";
      } else {
        detail = JSON.stringify(input);
      }
      return { type: "tool_call", icon: "tool", tool: name, text: detail };
    }

    // Plain text response (no tool calls)
    if (typeof obj.content === "string" && obj.content.trim()) {
      return { type: "assistant", icon: "message", text: obj.content.trim() };
    }

    return null;
  }

  // Final result
  if (obj.type === "result") {
    const turns = obj.num_turns ?? obj.usage?.num_turns;
    const cost = obj.total_cost_usd;
    return {
      type: "result",
      icon: obj.stop_reason === "max_turns" ? "error" : "success",
      text:
        obj.stop_reason === "max_turns"
          ? `Max turns reached — ${turns ?? "?"} turns`
          : `Done — ${turns ?? "?"} turns${cost != null ? `, cost: $${cost.toFixed(4)}` : ""}`,
      cost,
      turns,
    };
  }

  return null;
}

// ── Output parsing ────────────────────────────────────────────────────────────

function parseMistralOutput(logContent: string, skipLinesBefore = 0): ParsedOutput {
  const lines = logContent.split("\n");
  const relevantLines = skipLinesBefore > 0 ? lines.slice(skipLinesBefore) : lines;

  let maxTurnsReached = false;
  let agentAborted = false;
  let abortReason: string | null = null;
  let lastError: string | null = null;

  for (const line of relevantLines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      if (parsed.type === "result" && parsed.stop_reason === "max_turns") {
        maxTurnsReached = true;
      }

      if (parsed.role === "assistant" && typeof parsed.content === "string") {
        lastError = parsed.content.slice(0, 200);
        const abortMatch = parsed.content.match(/\[TASK_ABORTED\]:\s*(.*)/);
        if (abortMatch) {
          agentAborted = true;
          abortReason = abortMatch[1].trim().slice(0, 200);
        }
      }
    } catch {
      // Not JSON — skip
    }
  }

  return { sessionId: null, maxTurnsReached, agentAborted, abortReason, lastError };
}

// ── Command builder ───────────────────────────────────────────────────────────

function buildMistralCommand(opts: CommandOpts): string[] {
  const args: string[] = [];

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  } else if (!opts.usePromptUrl && opts.prompt) {
    args.push("--prompt", opts.prompt);
  }

  if (opts.allowedTools) {
    // Parse Claude-style tool string, strip parameterized forms like "Bash(git log *)" → "Bash",
    // map to Vibe tool names, deduplicate, filter to only supported tools
    const rawTools = opts.allowedTools
      .split(",")
      .map((t) => t.trim().replace(/\(.*\)$/, "").trim())
      .filter(Boolean);
    const vibeTools = Array.from(new Set(
      rawTools.map((t) => TOOL_MAP[t]).filter((t): t is string => t !== undefined),
    ));
    // Always include write_file so RESULT.md can be written
    if (!vibeTools.includes("write_file")) vibeTools.push("write_file");
    for (const tool of vibeTools) {
      args.push("--enabled-tools", tool);
    }
  }

  // Model is set in config.toml via initContainerConfig — not a CLI flag in Vibe
  args.push(
    "--output", "streaming",
    "--agent", "auto-approve",
    "--max-turns", String(opts.maxTurns ?? 60),
  );

  return args;
}

// ── Container init script ─────────────────────────────────────────────────────

function buildVibeInitScript(model: string): string {
  return `
export PYTHONUNBUFFERED=1
export PYTHON_KEYRING_BACKEND=keyring.backends.null.Keyring
export VIBE_HOME=/home/agent/.vibe
mkdir -p /home/agent/.vibe
printf '[agent]\\nauto_approve = true\\n\\n[model]\\nactive = "${model}"\\n' > /home/agent/.vibe/config.toml
`.trim();
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const mistralAdapter: ProviderAdapter = {
  id: "mistral",
  name: "Mistral Vibe",
  agentBinary: "vibe",
  models: MISTRAL_MODELS,

  authEnvKeys: ["MISTRAL_API_KEY"],
  getAuthEnv: getMistralAuthEnv,

  buildCommand: buildMistralCommand,

  parseLogLine: parseMistralLogLine,
  parseOutput: parseMistralOutput,
  extractSessionId: () => null,

  containerImage: "sandbox-mistral",
  bypassHosts: ["api.mistral.ai"],

  initContainerConfig(opts?: { model?: string }): ContainerConfig {
    const model = opts?.model ?? "devstral-2";
    return {
      initScript: buildVibeInitScript(model),
      envVars: {
        // Host-side patterns for sandbox-run.sh log monitor
        MAX_TURNS_GREP_PATTERN: "stop_reason.*max_turns",
        RESULT_GREP_PATTERN: '"type":"result"',
        // vibe uses --prompt, not -p
        AGENT_PROMPT_FLAG: "--prompt",
      },
    };
  },

  capabilities: {
    sessionResume: false,
    maxTurns: true,
    toolRestriction: true,
    hooks: false,
    streamingOutput: true,
    maxPrice: true,
  },

  mapToolNames(tools: string[]): string[] {
    return tools
      .map((t) => TOOL_MAP[t] ?? t)
      .filter((t) => VIBE_TOOL_NAMES.has(t));
  },
};
