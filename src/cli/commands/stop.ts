import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { runMigrations } from "../../db/migrate";
import { stopContainer } from "../../runtime/container";

export async function stopCommand(taskId: string) {
  runMigrations();
  const db = getDb();

  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.task_id, taskId))
    .get();

  if (!task) {
    // Try prefix match
    const all = db.select().from(schema.tasks).all();
    const match = all.find((t) => t.task_id.startsWith(taskId));
    if (!match) {
      console.error(`Task ${taskId} not found`);
      process.exit(1);
    }
    taskId = match.task_id;
  }

  console.log(`Stopping task ${taskId.slice(0, 8)}...`);
  const sessionId = await stopContainer(taskId);

  db.update(schema.tasks)
    .set({
      status: "stopped",
      session_id: sessionId,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(eq(schema.tasks.task_id, taskId))
    .run();

  console.log(`Task ${taskId.slice(0, 8)} stopped.`);
  if (sessionId) console.log(`  Session: ${sessionId}`);
}
