import { join } from "path";
import { readFile } from "fs/promises";
import { runTask } from "../../runtime/runner";
import { runInteractive } from "../../runtime/interactive";
import { resolveProjectRoot } from "../git-root";
import { resolveTaskId, logsDir, worktreesDir } from "../logs-dir";
import { getProvider } from "../../providers";
import type { RunConfig } from "../../types";
import type { ParsedLogEntry } from "../../providers/types";

function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function renderEvent(entry: ParsedLogEntry, verbose: boolean): void {
  if (entry.type === "assistant" && entry.text) {
    const firstLine = entry.text.split("\n")[0].trim();
    if (firstLine) console.log(`  \x1b[90m→\x1b[0m ${firstLine}`);
  } else if (verbose && entry.type === "tool_call" && entry.tool) {
    const detail = entry.text ? ` ${entry.text}` : "";
    console.log(`  \x1b[90m[${entry.tool}${detail}]\x1b[0m`);
  }
}

export async function refineCommand(
  taskIdArg: string,
  prompt: string,
  opts: { quiet?: boolean; verbose?: boolean; project?: string; interactive?: boolean; allowCommit?: boolean },
) {
  const projectRoot = await resolveProjectRoot(opts.project);

  const taskId = await resolveTaskId(projectRoot, taskIdArg);
  if (!taskId) {
    console.error(`Task ${taskIdArg} not found in ${logsDir(projectRoot)}`);
    process.exit(1);
  }

  const logPath = join(logsDir(projectRoot), `${taskId}.log`);
  const worktreePath = join(worktreesDir(projectRoot), taskId);

  // Extract session_id from the log file
  const adapter = getProvider("claude");
  let sessionId: string | null = null;
  try {
    const logContent = await readFile(logPath, "utf-8");
    sessionId = adapter.extractSessionId(logContent);
  } catch {
    console.error(`Could not read log file: ${logPath}`);
    process.exit(1);
  }

  if (!sessionId) {
    console.error(`No session ID found in ${logPath} — cannot refine.`);
    console.error("Only completed Claude tasks with a session can be refined.");
    process.exit(1);
  }

  const worktreePrefix = join(projectRoot, ".ysa", "worktrees/");
  const branch = `task/${taskId.slice(0, 8)}`;

  const config: RunConfig = {
    taskId: crypto.randomUUID(),
    prompt,
    branch,
    projectRoot,
    worktreePrefix,
    provider: "claude",
    maxTurns: 60,
    resumeSessionId: sessionId,
    resumePrompt: prompt,
    resumeWorktree: worktreePath,
    allowCommit: opts.allowCommit,
  };

  if (opts.interactive) {
    await runInteractive(config);
    return;
  }

  const handle = await runTask(config, {
    onProgress: (msg) => {
      if (!opts.quiet) console.log(`  \x1b[90m${msg}\x1b[0m`);
    },
    onEvent: (entry: ParsedLogEntry) => {
      if (!opts.quiet) renderEvent(entry, !!opts.verbose);
    },
  });
  process.once("SIGINT", () => { handle.stop().catch(() => {}); });
  const result = await handle.wait();

  console.log();
  if (result.status === "completed") {
    console.log(`\x1b[32m✓\x1b[0m Completed in ${formatDuration(result.duration_ms)}`);
  } else {
    const reason = result.error ?? result.failure_reason ?? "unknown";
    console.log(`\x1b[31m✗\x1b[0m Failed — ${reason}`);
    if (result.log_path) console.log(`  Logs: ${result.log_path}`);
  }
  console.log(`  Files: ${worktreePath}`);
  if (result.session_id) console.log(`  Session: ${result.session_id}`);

  process.exit(result.status === "completed" ? 0 : 1);
}
