import { readFile, stat } from "fs/promises";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { runMigrations } from "../../db/migrate";

export async function logsCommand(
  taskId: string,
  opts: { follow?: boolean; tail?: string },
) {
  runMigrations();
  const db = getDb();

  // Support prefix match
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
  }

  if (!task.log_path) {
    console.error(`No log path for task ${task.task_id.slice(0, 8)}`);
    process.exit(1);
  }

  try {
    await stat(task.log_path);
  } catch {
    console.error(`Log file not found: ${task.log_path}`);
    process.exit(1);
  }

  const raw = await readFile(task.log_path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const tailN = opts.tail ? parseInt(opts.tail) : undefined;
  const relevant = tailN ? lines.slice(-tailN) : lines;

  for (const line of relevant) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "system") {
        console.log(`\x1b[90m[system] ${parsed.session_id ? `session: ${parsed.session_id}` : ""}\x1b[0m`);
      } else if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text") console.log(block.text);
        }
      } else if (parsed.type === "result") {
        const status = parsed.subtype === "success" ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
        console.log(`${status} ${parsed.subtype}`);
      }
    } catch {
      console.log(line);
    }
  }

  if (opts.follow && task.status === "running") {
    console.log("\x1b[90m--- following ---\x1b[0m");
    let lastSize = lines.length;
    const interval = setInterval(async () => {
      try {
        const content = await readFile(task!.log_path!, "utf-8");
        const newLines = content.split("\n").filter((l) => l.trim());
        if (newLines.length > lastSize) {
          for (let i = lastSize; i < newLines.length; i++) {
            try {
              const parsed = JSON.parse(newLines[i]);
              if (parsed.type === "assistant" && parsed.message?.content) {
                for (const block of parsed.message.content) {
                  if (block.type === "text") console.log(block.text);
                }
              }
            } catch {
              console.log(newLines[i]);
            }
          }
          lastSize = newLines.length;
        }
      } catch {
        clearInterval(interval);
      }
    }, 1000);
  }
}
