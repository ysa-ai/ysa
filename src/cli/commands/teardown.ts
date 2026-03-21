import { join } from "path";
import { resolveProjectRoot } from "../git-root";
import { resolveTaskId, logsDir, worktreesDir } from "../logs-dir";
import { teardownContainer } from "../../runtime/container";
import { removeWorktree } from "../../runtime/worktree";

export async function teardownCommand(taskIdArg: string, opts: { project?: string } = {}) {
  const projectRoot = await resolveProjectRoot(opts.project);

  const taskId = await resolveTaskId(projectRoot, taskIdArg);
  if (!taskId) {
    console.error(`Task ${taskIdArg} not found in ${logsDir(projectRoot)}`);
    process.exit(1);
  }

  const worktree = join(worktreesDir(projectRoot), taskId);
  const branch = `task/${taskId.slice(0, 8)}`;

  console.log(`Tearing down task ${taskId.slice(0, 8)}...`);
  await teardownContainer(taskId);
  await removeWorktree(projectRoot, worktree, branch).catch(() => {});
  console.log(`Task ${taskId.slice(0, 8)} torn down.`);
}
