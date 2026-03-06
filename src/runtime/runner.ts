import { readFile, stat, mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { getProvider } from "../providers";
import { createWorktree, removeWorktree, prepareWorktree } from "./worktree";
import { spawnSandbox } from "./container";
import { getOrCreateAuthToken } from "../api/config-store";
import type { RunConfig, RunResult, TaskStatus } from "../types";

function progressEntry(message: string): string {
  return JSON.stringify({ type: "system", subtype: "progress", message }) + "\n";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runTask(config: RunConfig): Promise<RunResult> {
  const taskId = config.taskId;
  const worktree = `${config.worktreePrefix}${taskId}`;
  const branch = `task/${taskId.slice(0, 8)}`;
  const baseBranch = config.branch;
  const gitDir = join(config.projectRoot, ".git");
  const logDir = join(config.projectRoot, ".ysa", "logs");
  const logPath = join(logDir, `${taskId}.log`);

  await mkdir(logDir, { recursive: true });
  await mkdir(config.worktreePrefix, { recursive: true });

  // 1. Create worktree (skip if resuming - worktree already exists)
  if (!config.resumeSessionId) {
    await appendFile(logPath, progressEntry("Creating git worktree..."));
    // Remove stale worktree from a previous failed/stopped run before recreating
    await removeWorktree(config.projectRoot, worktree, branch).catch(() => {});
    const wt = await createWorktree(config.projectRoot, worktree, branch, baseBranch);
    if (!wt.ok) {
      return {
        task_id: taskId,
        status: "failed",
        session_id: null,
        error: `Worktree failed: ${wt.error}`,
        failure_reason: "infrastructure",
        log_path: logPath,
        duration_ms: 0,
      };
    }

    // 2. Prepare worktree (copy .mcp.json, env files)
    await prepareWorktree(worktree, config.projectRoot);
  }

  // 3. Resolve adapter + get auth
  const adapter = getProvider(config.provider ?? "claude");
  const authEnv = await adapter.getAuthEnv();

  // 4. Build auth env flags string for sandbox (passed as AGENT_AUTH_ENV_FLAGS)
  const agentAuthEnvFlags = adapter.authEnvKeys
    .filter((key) => authEnv[key])
    .map((key) => `-e ${key}`)
    .join(" ");

  // 5. Build CLI args
  const cliArgs = adapter.buildCommand({
    prompt: config.prompt,
    resumeSessionId: config.resumeSessionId,
    resumePrompt: config.resumePrompt,
    allowedTools: config.allowedTools?.join(","),
    maxTurns: config.maxTurns ?? 60,
    usePromptUrl: !!config.promptUrl,
    model: config.model,
  });

  // 6. Build container init config
  const containerConfig = adapter.initContainerConfig({ model: config.model });

  // 7. Spawn sandbox
  const startTime = Date.now();
  const env: Record<string, string> = { ...authEnv, ...containerConfig.envVars };
  if (config.promptUrl) env.PROMPT_URL = config.promptUrl;
  env.PROMPT_TOKEN = getOrCreateAuthToken();

  const proc = spawnSandbox({
    worktree,
    gitDir,
    branch,
    mode: "readwrite",
    id: taskId,
    cliArgs,
    env,
    logPath,
    networkPolicy: config.networkPolicy,
    agentBinary: adapter.agentBinary,
    agentImage: adapter.containerImage,
    agentInitScript: containerConfig.initScript,
    agentAuthEnvFlags,
    extraPodEnv: `-e CONTEXT_ID=${taskId}`,
    shadowDirs: config.shadowDirs,
  });

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startTime;

  // 8. Parse output
  const parsed = await fileExists(logPath)
    ? adapter.parseOutput(await readFile(logPath, "utf-8"))
    : { sessionId: null, maxTurnsReached: false, agentAborted: false, abortReason: null, lastError: null };

  // 9. Determine result
  let status: TaskStatus;
  let error: string | null = null;
  let failureReason: "max_turns" | "infrastructure" | "agent_aborted" | null = null;

  if (parsed.agentAborted) {
    status = "failed";
    error = parsed.abortReason || "Agent aborted the task";
    failureReason = "agent_aborted";
  } else if (parsed.maxTurnsReached) {
    status = "failed";
    error = `Max turns (${config.maxTurns ?? 60}) reached.`;
    failureReason = "max_turns";
  } else if (exitCode === 0 || (!parsed.lastError && (config.provider ?? "claude") === "claude")) {
    // exitCode !== 0 with no lastError (Claude only) is a known false positive: Claude writes to
    // settings.json (mounted :ro for security) at session end and exits with code 1.
    // Since the work completed without errors, treat it as success.
    status = "completed";
  } else {
    status = "failed";
    failureReason = "infrastructure";
    error = `Agent exited with code ${exitCode}`;
    if (parsed.lastError) error += `. ${parsed.lastError}`;
  }

  return {
    task_id: taskId,
    status,
    session_id: parsed.sessionId,
    error,
    failure_reason: failureReason,
    log_path: logPath,
    duration_ms: durationMs,
  };
}
