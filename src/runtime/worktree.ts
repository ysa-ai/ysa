import { stat, readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runShell(
  cmd: string,
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function createWorktree(
  projectRoot: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
): Promise<{ ok: boolean; error?: string }> {
  // Ensure the repo has at least one commit — worktrees require a valid HEAD
  const headCheck = await runShell(`git -C ${projectRoot} rev-parse HEAD`);
  if (!headCheck.ok) {
    const init = await runShell(
      `git -C ${projectRoot} -c user.email="ysa@localhost" -c user.name="ysa" commit --allow-empty -m "init"`,
    );
    if (!init.ok) return { ok: false, error: `Failed to create initial commit: ${init.stderr}` };
  }

  // Verify baseBranch exists — if not (e.g. fresh repo with different default branch), ignore it
  let resolvedBase = "";
  if (baseBranch) {
    const refCheck = await runShell(`git -C ${projectRoot} rev-parse --verify ${baseBranch}`);
    if (refCheck.ok) resolvedBase = ` ${baseBranch}`;
  }

  // Create new branch, optionally based on a specific branch
  let result = await runShell(
    `git -C ${projectRoot} worktree add ${worktreePath} -b ${branch}${resolvedBase}`,
  );
  if (result.ok) return { ok: true };

  // Branch may already exist — try without -b
  result = await runShell(
    `git -C ${projectRoot} worktree add ${worktreePath} ${branch}`,
  );
  if (result.ok) return { ok: true };

  return { ok: false, error: result.stderr };
}

export async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  // Try git worktree remove first
  const wt = await runShell(
    `git -C ${projectRoot} worktree remove ${worktreePath} --force`,
  );

  // If git doesn't recognize it as a worktree but the directory still exists,
  // remove the directory manually and prune stale worktree entries
  if (!wt.ok && await fileExists(worktreePath)) {
    const rm = await runShell(`rm -rf ${worktreePath}`);
    if (!rm.ok) {
      throw new Error(`Failed to remove stale worktree directory: ${rm.stderr}`);
    }
    await runShell(`git -C ${projectRoot} worktree prune`);
  }

  // Branch delete is best-effort (may not exist)
  await runShell(
    `git -C ${projectRoot} branch -D ${branch} 2>/dev/null || true`,
  );
}

export async function prepareWorktree(
  worktreePath: string,
  projectRoot: string,
  envFiles?: string[],
  mcpConfigPath?: string | null,
): Promise<void> {
  // Copy .mcp.json into worktree for MCP server discovery
  const mcpSrc = mcpConfigPath || join(projectRoot, ".mcp.json");
  const mcpDst = join(worktreePath, ".mcp.json");
  if (await fileExists(mcpSrc)) {
    await writeFile(mcpDst, await readFile(mcpSrc));
  }

  // Copy env files
  if (envFiles) {
    for (const envFile of envFiles) {
      const src = join(projectRoot, envFile);
      if (await fileExists(src)) {
        const dst = join(worktreePath, envFile);
        const dstDir = join(worktreePath, ...envFile.split("/").slice(0, -1));
        await mkdir(dstDir, { recursive: true });
        await Bun.write(dst, await readFile(src));
      }
    }
  }
}
