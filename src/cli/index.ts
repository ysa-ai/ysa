#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { version: pkgVersion } = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../package.json"), "utf-8"),
) as { version: string };
import { runCommand } from "./commands/run";
import { listCommand } from "./commands/list";
import { stopCommand } from "./commands/stop";
import { logsCommand } from "./commands/logs";
import { teardownCommand } from "./commands/teardown";
import { refineCommand } from "./commands/refine";
import { setupCommand } from "./commands/setup";
import { runtimeCommand } from "./commands/runtime";

const program = new Command();

program
  .name("ysa")
  .description("Run sandboxed AI coding tasks")
  .version(pkgVersion);

program
  .command("run")
  .description("Run a task in a sandboxed container")
  .argument("<prompt>", "The prompt/instructions for the task")
  .option("-b, --branch <branch>", "Git branch name", `task-${Date.now()}`)
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .option("-m, --max-turns <n>", "Max agent turns", "60")
  .option("-n, --network <policy>", "Network policy: none|strict|custom", "none")
  .option("-t, --tools <tools>", "Comma-separated allowed tools override")
  .option("-q, --quiet", "Show progress only, no agent output")
  .option("-v, --verbose", "Show full log including tool calls")
  .option("-i, --interactive", "Attach stdin/stdout for a live terminal session inside the sandbox")
  .option("--no-commit", "Prevent the agent from committing to git (analysis/review tasks)")
  .action((prompt: string, opts: Record<string, string | boolean>) => {
    runCommand(prompt, {
      branch: opts.branch as string,
      project: opts.project as string | undefined,
      maxTurns: opts.maxTurns as string,
      network: opts.network as string,
      tools: opts.tools as string | undefined,
      quiet: opts.quiet as boolean | undefined,
      verbose: opts.verbose as boolean | undefined,
      interactive: opts.interactive === true,
      allowCommit: opts.commit !== false,
    });
  });

program
  .command("list")
  .alias("ls")
  .description("List tasks")
  .option("-s, --status <status>", "Filter by status (running|done)")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .action((opts: { status?: string; project?: string }) => {
    listCommand(opts);
  });

program
  .command("stop")
  .description("Stop a running task")
  .argument("<task-id>", "Task ID (or prefix)")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .action((taskId: string, opts: { project?: string }) => {
    stopCommand(taskId, opts);
  });

program
  .command("logs")
  .description("View task logs")
  .argument("<task-id>", "Task ID (or prefix)")
  .option("-f, --follow", "Follow log output")
  .option("--tail <n>", "Show last N lines")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .action((taskId: string, opts: { follow?: boolean; tail?: string; project?: string }) => {
    logsCommand(taskId, opts);
  });

program
  .command("teardown")
  .description("Teardown task resources (container + worktree)")
  .argument("<task-id>", "Task ID (or prefix)")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .action((taskId: string, opts: { project?: string }) => {
    teardownCommand(taskId, opts);
  });

program
  .command("refine")
  .description("Continue/refine a completed task")
  .argument("<task-id>", "Task ID (or 8-char prefix)")
  .argument("<prompt>", "Follow-up instructions")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .option("-q, --quiet", "Show progress only, no agent output")
  .option("-v, --verbose", "Show full log including tool calls")
  .option("-i, --interactive", "Attach stdin/stdout for a live terminal session")
  .option("--no-commit", "Prevent the agent from committing to git")
  .action((taskId: string, prompt: string, opts: { project?: string; quiet?: boolean; verbose?: boolean; interactive?: boolean; commit?: boolean }) => {
    refineCommand(taskId, prompt, { ...opts, allowCommit: opts.commit !== false });
  });

program
  .command("runtime")
  .description("Manage sandbox runtimes for this project")
  .argument("<action>", "add | remove | list | detect")
  .argument("[tool]", "Tool to add/remove, e.g. node@22 or python@3.12")
  .option("-p, --project <path>", "Project root directory (default: auto-detected git root)")
  .action((action: string, tool: string | undefined, opts: { project?: string }) => {
    runtimeCommand(action, tool, opts);
  });

program
  .command("setup")
  .description("First-run setup: preflight checks, image build, CA cert, network hooks")
  .action(() => {
    setupCommand();
  });

program.parse();
