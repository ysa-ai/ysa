import { desc } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { runMigrations } from "../../db/migrate";

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "-";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, Math.floor((e - s) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function listCommand(opts: { status?: string; json?: boolean }) {
  runMigrations();
  const db = getDb();
  let rows = db
    .select()
    .from(schema.tasks)
    .orderBy(desc(schema.tasks.created_at))
    .all();

  if (opts.status) {
    rows = rows.filter((r) => r.status === opts.status);
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log(
    "ID        Status      Branch          Duration  Prompt",
  );
  console.log("\u2500".repeat(80));
  for (const r of rows) {
    const id = r.task_id.slice(0, 8);
    const status = r.status.padEnd(11);
    const branch = (r.branch || "").slice(0, 15).padEnd(15);
    const dur =
      r.finished_at && r.started_at
        ? formatDuration(r.started_at, r.finished_at)
        : r.status === "running"
          ? "running..."
          : "-";
    const prompt = (r.prompt || "").slice(0, 30);
    console.log(
      `${id}  ${status} ${branch} ${dur.padEnd(9)} ${prompt}`,
    );
  }
}
