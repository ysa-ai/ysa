#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./commands/run";
import { listCommand } from "./commands/list";
import { stopCommand } from "./commands/stop";
import { logsCommand } from "./commands/logs";
import { teardownCommand } from "./commands/teardown";

const program = new Command();

program
  .name("ysa")
  .description("Run sandboxed AI coding tasks")
  .version("0.0.1");

program
  .command("run")
  .description("Run a task in a sandboxed container")
  .argument("<prompt>", "The prompt/instructions for the task")
  .option("-b, --branch <branch>", "Git branch name", `task-${Date.now()}`)
  .option("-p, --project <path>", "Project root directory", process.cwd())
  .option("-m, --max-turns <n>", "Max agent turns", "60")
  .option("-n, --network <policy>", "Network policy: none|filtered|full", "none")
  .option("-t, --tools <tools>", "Comma-separated allowed tools override")
  .action((prompt: string, opts: Record<string, string>) => {
    runCommand(prompt, {
      branch: opts.branch,
      project: opts.project,
      maxTurns: opts.maxTurns,
      network: opts.network,
      tools: opts.tools,
    });
  });

program
  .command("list")
  .alias("ls")
  .description("List tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("--json", "Output as JSON")
  .action((opts: { status?: string; json?: boolean }) => {
    listCommand(opts);
  });

program
  .command("stop")
  .description("Stop a running task")
  .argument("<task-id>", "Task ID (or prefix)")
  .action((taskId: string) => {
    stopCommand(taskId);
  });

program
  .command("logs")
  .description("View task logs")
  .argument("<task-id>", "Task ID (or prefix)")
  .option("-f, --follow", "Follow log output")
  .option("--tail <n>", "Show last N lines")
  .action((taskId: string, opts: { follow?: boolean; tail?: string }) => {
    logsCommand(taskId, opts);
  });

program
  .command("teardown")
  .description("Teardown task resources (container + worktree)")
  .argument("<task-id>", "Task ID (or prefix)")
  .action((taskId: string) => {
    teardownCommand(taskId);
  });

program.parse();
