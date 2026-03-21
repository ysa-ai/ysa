import { readdir } from "fs/promises";
import { join } from "path";

export function logsDir(projectRoot: string): string {
  return join(projectRoot, ".ysa", "logs");
}

export function worktreesDir(projectRoot: string): string {
  return join(projectRoot, ".ysa", "worktrees");
}

// Resolve a full task ID from a prefix by scanning the logs directory.
// Returns null if not found.
export async function resolveTaskId(projectRoot: string, prefix: string): Promise<string | null> {
  const dir = logsDir(projectRoot);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const match = files.find(
    (f) => f.endsWith(".log") && (f === `${prefix}.log` || f.startsWith(prefix)),
  );
  return match ? match.slice(0, -4) : null;
}
