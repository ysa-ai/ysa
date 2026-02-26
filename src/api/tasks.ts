import { z } from "zod";
import { router, publicProcedure } from "./init";
import { getDb, schema } from "../db";
import { eq, desc } from "drizzle-orm";
import { readFile, stat, appendFile } from "fs/promises";
import { join } from "path";
import { getProvider } from "../providers";
import type { ParsedLogEntry } from "../types";
import { getServerConfig } from "./config-store";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Hosts whose traffic is internal plumbing — don't show in the UI log viewer.
// Bypass hosts get full access anyway; showing them just clutters the logs.
const HIDDEN_LOG_HOSTS = [
  "api.anthropic.com",
  "sentry.io",
  "statsig.anthropic.com",
  "datadoghq.com",
  "host.containers.internal",
  "registry.npmjs.org",
];

function networkLogPath(logPath: string): string {
  return logPath.replace(/\.log$/, "-network.log");
}

async function scrapeProxyLogs(taskId: string, logPath: string): Promise<void> {
  try {
    const netLog = networkLogPath(logPath);
    let existing = new Set<string>();
    if (await fileExists(netLog)) {
      const content = await readFile(netLog, "utf-8");
      for (const line of content.split("\n")) {
        if (line.trim()) existing.add(line);
      }
    }

    const proc = Bun.spawn(["podman", "logs", "ysa-proxy"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    const output = (stdout + stderr).trim();
    if (!output) return;

    const newLines = output
      .split("\n")
      .filter((line) => line.includes(`[${taskId}]`))
      .filter((line) => /\[(ALLOW|BLOCK)\]/.test(line))
      .filter((line) => !existing.has(line));

    if (newLines.length > 0) {
      await appendFile(netLog, newLines.join("\n") + "\n");
    }
  } catch {
    // Proxy not running or no logs
  }
}

async function getProxyLogs(taskId: string, logPath: string): Promise<ParsedLogEntry[]> {
  await scrapeProxyLogs(taskId, logPath);

  const netLog = networkLogPath(logPath);
  if (!(await fileExists(netLog))) return [];

  const raw = await readFile(netLog, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => !HIDDEN_LOG_HOSTS.some((h) => line.includes(h)))
    .map((line) => {
      const tsMatch = line.match(/^\[([^\]]+)\]/);
      const ts = tsMatch ? new Date(tsMatch[1]).getTime() : undefined;
      const isBlock = line.includes("[BLOCK]");
      const actionMatch = line.match(/\[(ALLOW|BLOCK)\]/);
      const cleaned = actionMatch ? line.slice(line.indexOf(actionMatch[0])) : line;
      return {
        type: "network" as const,
        icon: isBlock ? "block" : "allow",
        text: cleaned,
        ts,
      };
    });
}

export const tasksRouter = router({
  config: publicProcedure.query(() => {
    return getServerConfig();
  }),

  list: publicProcedure.query(() => {
    const db = getDb();
    return db.select().from(schema.tasks).orderBy(desc(schema.tasks.created_at)).all();
  }),

  get: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error(`Task ${input.taskId} not found`);
      return task;
    }),

  result: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task?.worktree) return null;
      const resultPath = join(task.worktree, "RESULT.md");
      if (!(await fileExists(resultPath))) return null;
      return await readFile(resultPath, "utf-8");
    }),

  log: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        tail: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task?.log_path) return [];
      if (!(await fileExists(task.log_path))) return [];

      const adapter = getProvider(task.provider ?? "claude");
      const raw = await readFile(task.log_path, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      const entries = lines
        .map((line) => {
          try {
            return adapter.parseLogLine(line);
          } catch {
            return { type: "raw" as const, icon: ">", text: line };
          }
        })
        .filter(Boolean) as ParsedLogEntry[];

      // Append proxy logs if task uses strict network policy
      if (task.network_policy === "strict") {
        const proxyEntries = await getProxyLogs(input.taskId, task.log_path);
        if (proxyEntries.length > 0) {
          entries.push(...proxyEntries);
        }
      }

      if (input.tail) return entries.slice(-input.tail);
      return entries;
    }),
});
