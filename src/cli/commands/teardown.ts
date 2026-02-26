import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { runMigrations } from "../../db/migrate";
import { teardownContainer } from "../../runtime/container";
import { removeWorktree } from "../../runtime/worktree";

export async function teardownCommand(taskId: string) {
  runMigrations();
  const db = getDb();

  let task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.task_id, taskId))
    .get();

  if (!task) {
    const all = db.select().from(schema.tasks).all();
    const match = all.find((t) => t.task_id.startsWith(taskId));
    if (!match) {
      console.error(`Task ${taskId} not found`);
      process.exit(1);
    }
    task = match;
    taskId = match.task_id;
  }

  console.log(`Tearing down task ${taskId.slice(0, 8)}...`);

  await teardownContainer(taskId);
  if (task.worktree) {
    // Derive projectRoot from worktree path
    const projectRoot = task.worktree.replace(
      new RegExp(`\\.ysa/worktrees/${taskId}$`),
      "",
    );
    await removeWorktree(projectRoot, task.worktree, task.branch);
  }

  db.update(schema.tasks)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(schema.tasks.task_id, taskId))
    .run();

  console.log(`Task ${taskId.slice(0, 8)} torn down.`);
}
