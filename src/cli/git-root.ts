import { stat } from "fs/promises";
import { dirname, join } from "path";

export async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // reached filesystem root
      dir = parent;
    }
  }
}

export async function resolveProjectRoot(explicitPath?: string): Promise<string> {
  if (explicitPath) return explicitPath;

  const root = await findGitRoot(process.cwd());
  if (root) return root;

  console.error("No git repository found.");
  console.error("ysa uses git worktrees to isolate agent work from your directory.");
  console.error("");
  console.error("Run 'git init && git commit --allow-empty -m \"init\"' to get started,");
  console.error("then re-run your command.");
  process.exit(1);
}
