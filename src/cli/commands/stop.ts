import { resolveProjectRoot } from "../git-root";
import { resolveTaskId, logsDir } from "../logs-dir";
import { stopContainer } from "../../runtime/container";

export async function stopCommand(taskIdArg: string, opts: { project?: string } = {}) {
  const projectRoot = await resolveProjectRoot(opts.project);

  const taskId = await resolveTaskId(projectRoot, taskIdArg);
  if (!taskId) {
    console.error(`Task ${taskIdArg} not found in ${logsDir(projectRoot)}`);
    process.exit(1);
  }

  console.log(`Stopping task ${taskId.slice(0, 8)}...`);
  const logPath = `${logsDir(projectRoot)}/${taskId}.log`;
  await stopContainer(taskId, { logPath });
  console.log(`Task ${taskId.slice(0, 8)} stopped.`);
}
