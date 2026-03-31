import { readFile, stat, mkdir, appendFile } from "fs/promises";
import { join, basename } from "path";
import { getProvider } from "../providers";
import { createWorktree, removeWorktree, prepareWorktree } from "./worktree";
import { spawnSandbox, stopContainer, buildProjectImage, projectImageName, getImagePackagesHash, installDepsInShadow } from "./container";
import { ensureProxy } from "./proxy";
import { ensureMiseRuntimes } from "./mise";
import { getOrCreateAuthToken } from "./prompt-token";
import { readYsaConfig } from "../cli/ysa-config";
import type { RunConfig, RunResult, TaskStatus, TaskHandle } from "../types";
import type { ParsedLogEntry } from "../providers/types";

export interface RunOptions {
  onProgress?: (message: string) => void;
  onEvent?: (event: ParsedLogEntry) => void;
  onComplete?: (result: RunResult) => void;
  onError?: (error: Error) => void;
}

function progressEntry(message: string): string {
  return JSON.stringify({ type: "system", subtype: "progress", message }) + "\n";
}

function stoppableEntry(value: boolean): string {
  return JSON.stringify({ type: "system", subtype: "stoppable", value }) + "\n";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function computeShadowVolumeNames(config: RunConfig): string[] {
  if (!config.depsCacheKey || !config.depInstallCmd) return [];
  const shadowDir = (config.shadowDirs ?? ["node_modules"])[0] ?? "node_modules";
  return [`shadow-${shadowDir.replace(/\//g, "-")}-${config.depsCacheKey}`];
}

// Tail a log file, yielding complete lines as they appear.
// Stops when the process exits (exited resolves).
async function* tailLog(
  logPath: string,
  exited: Promise<number>,
): AsyncGenerator<string> {
  let offset = 0;
  let done = false;

  exited.then(() => { done = true; });

  while (true) {
    try {
      const file = Bun.file(logPath);
      const size = file.size;
      if (size > offset) {
        const content = await file.text();
        const chunk = content.slice(offset);
        const lines = chunk.split("\n");
        // Last element may be an incomplete line — hold it for the next iteration
        const completeLines = lines.slice(0, -1);
        for (const line of completeLines) {
          if (line.trim()) yield line;
        }
        offset = content.length - lines[lines.length - 1].length;
      }
    } catch {
      // File not created yet
    }

    if (done) {
      // Final drain: read any remaining lines after process exits
      try {
        const content = await Bun.file(logPath).text();
        if (content.length > offset) {
          const remaining = content.slice(offset).split("\n");
          for (const line of remaining) {
            if (line.trim()) yield line;
          }
        }
      } catch {}
      break;
    }

    await new Promise<void>((r) => setTimeout(r, 200));
  }
}

export async function runTask(config: RunConfig, opts?: RunOptions): Promise<TaskHandle> {
  const taskId = config.taskId;
  const worktree = config.resumeWorktree ?? `${config.worktreePrefix}${taskId}`;
  const branch = config.branch ?? `task/${taskId.slice(0, 8)}`;
  const gitDir = join(config.projectRoot, ".git");
  const logDir = join(config.projectRoot, ".ysa", "logs");
  const logPath = join(logDir, `${taskId}.log`);
  const startTime = Date.now();

  const emitProgress = (msg: string) => {
    opts?.onProgress?.(msg);
  };

  // Eagerly compute shadow volume names — available on handle before container exits
  const shadowVolumes = computeShadowVolumeNames(config);

  // Promise/resolve pair — resultPromise never rejects
  let resolveResult!: (r: RunResult) => void;
  const resultPromise = new Promise<RunResult>(r => { resolveResult = r; });

  const completeWith = (result: RunResult) => {
    resolveResult(result);
    queueMicrotask(() => opts?.onComplete?.(result));
  };

  const failWith = (error: Error) => {
    const result: RunResult = {
      task_id: taskId,
      status: "failed",
      session_id: null,
      error: error.message,
      failure_reason: "infrastructure",
      log_path: logPath,
      duration_ms: Date.now() - startTime,
    };
    resolveResult(result);
    queueMicrotask(() => opts?.onError?.(error));
  };

  let intentionallyStopped = false;

  const handle: TaskHandle = {
    taskId,
    logPath,
    shadowVolumes,
    wait: () => resultPromise,
    stop: async () => {
      intentionallyStopped = true;
      await stopContainer(taskId, { logPath, labels: config.extraLabels });
    },
  };

  await mkdir(logDir, { recursive: true });
  await mkdir(config.worktreePrefix, { recursive: true });

  // 1. Create worktree (skip if resuming)
  if (!config.resumeSessionId && !config.resumeWorktree) {
    await appendFile(logPath, progressEntry("Creating git worktree..."));
    emitProgress("Creating git worktree...");
    await removeWorktree(config.projectRoot, worktree, branch).catch(() => {});
    const wt = await createWorktree(config.projectRoot, worktree, branch);
    if (!wt.ok) {
      failWith(new Error(`Worktree failed: ${wt.error}`));
      return handle;
    }

    // 2. Prepare worktree
    await prepareWorktree(worktree, config.projectRoot, undefined, undefined, config.worktreeFiles);
  }

  // 3. Resolve adapter + get auth
  const adapter = getProvider(config.provider ?? "claude");
  const authEnv = await adapter.getAuthEnv();

  // 4. Build auth env flags string
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

  // 7. Read .ysa.toml and resolve project image
  const ysaConfig = await readYsaConfig(config.projectRoot);
  const aptPackages = ysaConfig.sandbox?.packages ?? [];
  let agentImage = adapter.containerImage;

  if (aptPackages.length > 0) {
    const projImage = projectImageName(config.projectRoot, adapter.id);
    const targetHash = Bun.hash([...aptPackages].sort().join(",")).toString(16);
    const currentHash = await getImagePackagesHash(projImage);
    if (currentHash !== targetHash) {
      emitProgress("Building project sandbox image...");
      const built = await buildProjectImage(aptPackages, projImage, adapter.containerImage, adapter.packageManager, (line) => emitProgress(line));
      if (!built.ok) {
        failWith(new Error(`Image build failed: ${built.error}`));
        return handle;
      }
    }
    agentImage = projImage;
  }

  // 8. Proxy auto-start
  if (config.networkPolicy === "strict") {
    emitProgress("Starting network proxy...");
    await ensureProxy(config.proxyRules, undefined, config.serverPort);
  }

  // 9. Mise pre-install
  const miseVolume =
    config.miseVolume ??
    (await ensureMiseRuntimes(
      config.projectRoot,
      agentImage,
      emitProgress,
      ysaConfig.sandbox?.runtimes,
    ));

  // 10. Install dependencies into shadow volume (if depInstallCmd is set)
  let depCacheVolume: string | undefined;
  if (config.depInstallCmd) {
    const shadowDir = (config.shadowDirs ?? ["node_modules"])[0] ?? "node_modules";
    const shadowVolume = config.depsCacheKey
      ? `shadow-${shadowDir.replace(/\//g, "-")}-${config.depsCacheKey}`
      : `shadow-${shadowDir.replace(/\//g, "-")}-${taskId}`;

    const volumeExists = config.depsCacheKey
      ? (await Bun.spawn(["podman", "volume", "exists", shadowVolume]).exited) === 0
      : false;

    if (volumeExists) {
      await appendFile(logPath, progressEntry("Dependencies loaded from cache"));
      emitProgress("Dependencies loaded from cache");
    } else {
      await appendFile(logPath, stoppableEntry(false));
      await appendFile(logPath, progressEntry("Installing dependencies..."));
      emitProgress("Installing dependencies...");
      const installResult = await installDepsInShadow({
        worktree,
        installCmd: config.depInstallCmd,
        shadowVolume,
        shadowDir,
        image: agentImage,
        miseVolume,
      });
      if (!installResult.ok) {
        failWith(new Error(`Dependency install failed: ${installResult.error}`));
        return handle;
      }
      await appendFile(logPath, stoppableEntry(true));
    }

    // Pass the pre-populated volume to sandbox-run.sh so it uses it instead of creating a fresh one
    if (config.depsCacheKey) depCacheVolume = shadowVolume;
  }

  // 11. Spawn sandbox
  const env: Record<string, string> = { ...authEnv, ...containerConfig.envVars, ...config.extraEnv };
  if (config.promptUrl) env.PROMPT_URL = config.promptUrl;
  env.PROMPT_TOKEN = getOrCreateAuthToken();

  const sessionVolume = config.resumeWorktree
    ? `task-session-${basename(config.resumeWorktree)}`
    : undefined;

  emitProgress("Starting agent...");
  let proc: Awaited<ReturnType<typeof spawnSandbox>>;
  try {
    proc = await spawnSandbox({
      worktree,
      gitDir,
      branch,
      mode: config.allowCommit === false ? "readonly" : "readwrite",
      id: taskId,
      cliArgs,
      env,
      logPath,
      networkPolicy: config.networkPolicy,
      agentBinary: adapter.agentBinary,
      agentImage,
      agentInitScript: containerConfig.initScript,
      agentAuthEnvFlags,
      extraPodEnv: [
        `-e CONTEXT_ID=${taskId}`,
        ...Object.entries(config.extraEnv ?? {}).map(([k, v]) => `-e ${k}=${v}`),
      ].join(" "),
      extraLabels: config.extraLabels,
      shadowDirs: config.shadowDirs,
      depCacheVolume,
      miseVolume,
      sessionVolume,
    });
  } catch (err) {
    failWith(err instanceof Error ? err : new Error(String(err)));
    return handle;
  }

  // 12. Stream log output in real time
  const exitedPromise = proc.exited;
  if (opts?.onEvent || opts?.onProgress) {
    (async () => {
      for await (const line of tailLog(logPath, exitedPromise)) {
        try {
          const entry = adapter.parseLogLine(line);
          if (entry) opts.onEvent?.(entry);
        } catch {}
      }
    })();
  }

  // Background: wait for container exit, parse result, fire onComplete
  (async () => {
    try {
      const exitCode = await exitedPromise;
      const durationMs = Date.now() - startTime;

      const parsed = await fileExists(logPath)
        ? adapter.parseOutput(await readFile(logPath, "utf-8"))
        : { sessionId: null, maxTurnsReached: false, agentAborted: false, abortReason: null, lastError: null };

      if (intentionallyStopped) {
        completeWith({
          task_id: taskId,
          status: "stopped",
          session_id: parsed.sessionId,
          error: null,
          failure_reason: null,
          log_path: logPath,
          duration_ms: durationMs,
        });
        return;
      }

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
        status = "completed";
      } else {
        status = "failed";
        failureReason = "infrastructure";
        error = `Agent exited with code ${exitCode}`;
        if (parsed.lastError) error += `. ${parsed.lastError}`;
      }

      completeWith({
        task_id: taskId,
        status,
        session_id: parsed.sessionId,
        error,
        failure_reason: failureReason,
        log_path: logPath,
        duration_ms: durationMs,
      });
    } catch (err) {
      failWith(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return handle;
}
