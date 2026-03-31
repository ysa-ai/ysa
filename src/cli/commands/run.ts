import { join } from "path";
import { runTask } from "../../runtime/runner";
import { runInteractive } from "../../runtime/interactive";
import { resolveProjectRoot } from "../git-root";
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

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function runCommand(
  prompt: string,
  opts: {
    branch: string;
    project?: string;
    maxTurns: string;
    network: string;
    tools?: string;
    quiet?: boolean;
    verbose?: boolean;
    interactive?: boolean;
    allowCommit?: boolean;
  },
) {
  const projectRoot = await resolveProjectRoot(opts.project);
  const taskId = crypto.randomUUID();
  const worktreePrefix = join(projectRoot, ".ysa", "worktrees/");
  const worktreePath = `${worktreePrefix}${taskId}`;

  if (opts.interactive) {
    await runInteractive({
      taskId,
      prompt,
      branch: opts.branch,
      projectRoot,
      worktreePrefix,
      provider: "claude",
      networkPolicy: opts.network as "none" | "strict" | "custom",
    });
    return;
  }

  const config: RunConfig = {
    taskId,
    prompt,
    branch: opts.branch,
    projectRoot,
    worktreePrefix,
    provider: "claude",
    maxTurns: parseInt(opts.maxTurns),
    allowedTools: opts.tools?.split(","),
    networkPolicy: opts.network as "none" | "strict" | "custom",
    allowCommit: opts.allowCommit,
  };

  const runWithStreaming = async (runConfig: RunConfig) => {
    const handle = await runTask(runConfig, {
      onProgress: (msg) => {
        if (!opts.quiet) console.log(`  \x1b[90m${msg}\x1b[0m`);
      },
      onEvent: (entry: ParsedLogEntry) => {
        if (!opts.quiet) renderEvent(entry, !!opts.verbose);
      },
    });
    process.once("SIGINT", () => { handle.stop().catch(() => {}); });
    return handle.wait();
  };

  const result = await runWithStreaming(config);

  console.log();
  if (result.status === "completed") {
    console.log(`\x1b[32m✓\x1b[0m Completed in ${formatDuration(result.duration_ms)}`);
  } else {
    const reason = result.failure_reason === "max_turns"
      ? `max turns reached (${opts.maxTurns})`
      : result.error ?? result.failure_reason ?? "unknown";
    console.log(`\x1b[31m✗\x1b[0m Failed — ${reason}`);
    if (result.log_path) console.log(`  Logs: ${result.log_path}`);
  }

  console.log(`  Files: ${worktreePath}`);
  if (result.session_id) console.log(`  Session: ${result.session_id}`);

  // Interactive follow-up loop (issue #42)
  if (
    result.status === "completed" &&
    result.session_id &&
    process.stdin.isTTY
  ) {
    let currentSessionId = result.session_id;
    while (true) {
      console.log();
      process.stdout.write("  Follow up (or press Enter to exit): ");
      const followUp = await readLine();
      if (!followUp) {
        console.log("Bye");
        break;
      }

      console.log();
      const refineResult = await runWithStreaming({
        taskId: crypto.randomUUID(),
        prompt: followUp,
        branch: opts.branch,
        projectRoot,
        worktreePrefix,
        provider: "claude",
        maxTurns: parseInt(opts.maxTurns),
        networkPolicy: opts.network as "none" | "strict" | "custom",
        resumeSessionId: currentSessionId,
        resumePrompt: followUp,
        resumeWorktree: worktreePath,
      });

      console.log();
      if (refineResult.status === "completed") {
        console.log(`\x1b[32m✓\x1b[0m Completed in ${formatDuration(refineResult.duration_ms)}`);
        if (refineResult.session_id) currentSessionId = refineResult.session_id;
      } else {
        console.log(`\x1b[31m✗\x1b[0m Failed`);
        if (refineResult.log_path) console.log(`  Logs: ${refineResult.log_path}`);
        break;
      }
    }
  }

  process.exit(result.status === "completed" ? 0 : 1);
}
