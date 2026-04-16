import { mkdir } from "fs/promises";
import { join, basename } from "path";
import { getProvider } from "../providers";
import { createWorktree, removeWorktree, prepareWorktree } from "./worktree";
import { spawnSandbox } from "./container";

import type { RunConfig } from "../types";

export async function runInteractive(config: RunConfig): Promise<void> {
  const taskId = config.taskId;
  const worktree = config.resumeWorktree ?? `${config.worktreePrefix}${taskId}`;
  const branch = `task/${taskId.slice(0, 8)}`;
  const baseBranch = config.branch;
  const gitDir = join(config.projectRoot, ".git");
  const logDir = join(config.projectRoot, ".ysa", "logs");

  await mkdir(logDir, { recursive: true });
  await mkdir(config.worktreePrefix, { recursive: true });

  if (!config.resumeSessionId && !config.resumeWorktree) {
    await removeWorktree(config.projectRoot, worktree, branch).catch(() => {});
    const wt = await createWorktree(config.projectRoot, worktree, branch, baseBranch);
    if (!wt.ok) {
      console.error(`Worktree failed: ${wt.error}`);
      process.exit(1);
    }
    await prepareWorktree(worktree, config.projectRoot, undefined, undefined, config.worktreeFiles);
  }

  const adapter = getProvider(config.provider ?? "claude");
  const authEnv = await adapter.getAuthEnv();

  const agentAuthEnvFlags = adapter.authEnvKeys
    .filter((key) => authEnv[key])
    .map((key) => `-e ${key}`)
    .join(" ");

  const cliArgs = adapter.buildCommand({
    resumeSessionId: config.resumeSessionId,
    model: config.model,
    interactive: true,
  });

  const containerConfig = adapter.initContainerConfig({ model: config.model });
  const env: Record<string, string> = { ...authEnv, ...containerConfig.envVars, ...config.extraEnv };

  const extraEnvFlags = Object.entries(config.extraEnv ?? {}).map(([k, v]) => `-e ${k}=${v}`).join(" ");
  const extraPodEnv = [`-e CONTEXT_ID=${taskId}`, extraEnvFlags].filter(Boolean).join(" ");

  const proc = await spawnSandbox({
    worktree,
    gitDir,
    branch,
    mode: "readwrite",
    id: taskId,
    cliArgs,
    env,
    networkPolicy: config.networkPolicy,
    agentBinary: adapter.agentBinary,
    agentImage: adapter.containerImage,
    agentInitScript: containerConfig.initScript,
    agentAuthEnvFlags,
    extraPodEnv,
    extraLabels: config.extraLabels,
    shadowDirs: config.shadowDirs,
    interactive: true,
  });

  await proc.exited;
}
