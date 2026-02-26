import { join } from "path";
import { eq } from "drizzle-orm";
import { runTask } from "../../runtime/runner";
import { getDb, schema } from "../../db";
import { runMigrations } from "../../db/migrate";
import type { RunConfig } from "../../types";

export async function runCommand(
  prompt: string,
  opts: {
    branch: string;
    project: string;
    maxTurns: string;
    network: string;
    tools?: string;
  },
) {
  runMigrations();
  const db = getDb();
  const taskId = crypto.randomUUID();
  const worktreePrefix = join(opts.project, ".ysa", "worktrees/");

  console.log(`Task ${taskId.slice(0, 8)} starting...`);
  console.log(`  Branch: ${opts.branch}`);
  console.log(`  Network: ${opts.network}`);
  console.log(`  Max turns: ${opts.maxTurns}`);
  console.log();

  const config: RunConfig = {
    taskId,
    prompt,
    branch: opts.branch,
    projectRoot: opts.project,
    worktreePrefix,
    provider: "claude",
    maxTurns: parseInt(opts.maxTurns),
    allowedTools: opts.tools?.split(","),
    networkPolicy: opts.network as "none" | "strict" | "custom",
  };

  db.insert(schema.tasks)
    .values({
      task_id: taskId,
      prompt,
      status: "running",
      branch: opts.branch,
      worktree: `${worktreePrefix}${taskId}`,
      network_policy: opts.network ?? "none",
      started_at: new Date().toISOString(),
    })
    .run();

  try {
    const result = await runTask(config);

    db.update(schema.tasks)
      .set({
        status: result.status,
        session_id: result.session_id,
        error: result.error,
        failure_reason: result.failure_reason,
        log_path: result.log_path,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.tasks.task_id, taskId))
      .run();

    console.log();
    console.log(`Task ${taskId.slice(0, 8)} ${result.status}`);
    console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    if (result.session_id) console.log(`  Session: ${result.session_id}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    console.log(`  Log: ${result.log_path}`);

    process.exit(result.status === "completed" ? 0 : 1);
  } catch (err: any) {
    db.update(schema.tasks)
      .set({
        status: "failed",
        error: err.message,
        failure_reason: "infrastructure",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.tasks.task_id, taskId))
      .run();

    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}
