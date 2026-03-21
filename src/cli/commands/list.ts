import { readdir, stat } from "fs/promises";
import { join } from "path";
import { resolveProjectRoot } from "../git-root";
import { logsDir } from "../logs-dir";

async function runShell(cmd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

export async function listCommand(opts: { status?: string; project?: string }) {
  const projectRoot = await resolveProjectRoot(opts.project);
  const dir = logsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    console.log("No tasks found.");
    return;
  }

  const logFiles = entries.filter((e) => e.endsWith(".log"));
  if (logFiles.length === 0) {
    console.log("No tasks found.");
    return;
  }

  // Get running container task IDs via label filter
  const running = await runShell(
    "podman ps --filter label=task --format '{{index .Labels \"task\"}}' 2>/dev/null",
  );
  const runningIds = new Set(running.split("\n").filter(Boolean));

  const rows: { id: string; status: string; mtime: Date }[] = [];
  for (const entry of logFiles) {
    const taskId = entry.slice(0, -4); // strip .log
    const logPath = join(dir, entry);
    let mtime: Date;
    try {
      const s = await stat(logPath);
      mtime = s.mtime;
    } catch {
      continue;
    }

    const status = runningIds.has(taskId) ? "running" : "done";
    if (opts.status && opts.status !== status) continue;
    rows.push({ id: taskId, status, mtime });
  }

  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (rows.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log("ID        Status   Last modified");
  console.log("─".repeat(45));
  for (const r of rows) {
    const id = r.id.slice(0, 8);
    const status = r.status.padEnd(8);
    const when = r.mtime.toLocaleString();
    console.log(`${id}  ${status} ${when}`);
  }

  const logDir = logsDir(projectRoot);
  console.log(`\nLogs: ${logDir}`);
}
