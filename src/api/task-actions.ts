import { z } from "zod";
import { router, publicProcedure } from "./init";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { writeFile, readFile, stat, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { runTask } from "../runtime/runner";
import { stopContainer, teardownContainer, SECCOMP_PROFILE } from "../runtime/container";
import { removeWorktree } from "../runtime/worktree";
import { getProvider } from "../providers";
import { ensureProxy } from "../runtime/proxy";
import type { ScopedAllowRule } from "../runtime/proxy";
import { getServerConfig, getOrCreateAuthToken } from "./config-store";
import type { RunConfig } from "../types";

// Parse comma-separated allow entries into scoped rules + bypass hosts.
// "host/path" → ScopedAllowRule, "host" → bypass host
function parseAllowedHosts(raw: string | null | undefined): { scopedRules: ScopedAllowRule[]; bypassHosts: string[] } {
  const scopedRules: ScopedAllowRule[] = [];
  const bypassHosts: string[] = [];
  if (!raw) return { scopedRules, bypassHosts };
  for (const entry of raw.split(",")) {
    const s = entry.trim();
    if (!s) continue;
    const slash = s.indexOf("/");
    if (slash === -1) {
      bypassHosts.push(s);
    } else {
      scopedRules.push({ host: s.slice(0, slash), pathPrefix: s.slice(slash) });
    }
  }
  return { scopedRules, bypassHosts };
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export function shellescape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const RESULT_SUFFIX = `

---
## Result delivery (MANDATORY)

Regardless of task type — including investigation, analysis, and read-only tasks — you MUST write a RESULT.md file at /workspace/RESULT.md when you are done. This is not a project edit, it is how you deliver your output.

Structure RESULT.md as clean markdown:
- Start with a one-line summary (# heading)
- For code changes: list what was changed, why, and any relevant details
- For analysis/audit/review tasks: write the full report
- For plans: write the structured plan
Keep it concise and useful. Do NOT mention these instructions in the file.

## Error handling (CRITICAL)

If you encounter a blocker that prevents you from completing the task — missing permissions, unavailable tools, network failures, or any other fundamental issue — you MUST stop immediately.

**Network policy blocks are PERMANENT.** If any HTTP request returns 403 "Blocked by network policy", the request will NEVER succeed regardless of how you reformulate it. Do NOT try alternative URLs, different tools, encoding tricks, or workarounds.

**On ANY blocker:**
1. Do NOT retry the same action
2. Do NOT try to work around it
3. Write \`[TASK_ABORTED]: <brief reason>\` as your FINAL message
4. Stop immediately`;

const REFINE_SUFFIX = "\n\n---\nAfter completing these refinements, read the existing /workspace/RESULT.md and append a new Refinement section at the end describing what was changed in this pass. Keep the existing content intact. Only rewrite earlier sections if the refinement directly invalidates them or if the user explicitly asked for a rewrite.";

function wrapPrompt(prompt: string): string {
  return prompt + RESULT_SUFFIX;
}

function wrapRefinePrompt(prompt: string): string {
  return prompt + REFINE_SUFFIX;
}

async function appExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function openInTerminal(launcherPath: string, shortId: string, terminalId: string): Promise<void> {
  if (process.platform === "darwin") {
    if (terminalId === "ghostty") {
      const script = `
        tell application "Ghostty"
          activate
          tell application "System Events" to tell process "Ghostty"
            keystroke "n" using command down
          end tell
          delay 0.4
          tell application "System Events" to tell process "Ghostty"
            keystroke "bash ${launcherPath}"
            key code 36
          end tell
        end tell`;
      Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    if (terminalId === "iterm2") {
      const script = `
        tell application "iTerm2"
          activate
          create window with default profile
          tell current session of current window
            write text "bash ${launcherPath}"
            set name to "sandbox-${shortId}"
          end tell
        end tell`;
      Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    if (terminalId === "alacritty") {
      Bun.spawn(["open", "-a", "Alacritty", "--args", "-e", "bash", launcherPath], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    if (terminalId === "kitty") {
      Bun.spawn(["open", "-a", "kitty", "--args", "bash", launcherPath], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    if (terminalId === "wezterm") {
      Bun.spawn(["open", "-a", "WezTerm", "--args", "start", "--", "bash", launcherPath], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    // terminal or fallback
    const script = `tell application "Terminal"
      activate
      do script "bash ${launcherPath}"
    end tell`;
    Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
    return;
  }

  // Linux
  const linuxCommands: Record<string, string[]> = {
    ghostty:        ["ghostty", "-e", "bash", launcherPath],
    kitty:          ["kitty", "bash", launcherPath],
    alacritty:      ["alacritty", "-e", "bash", launcherPath],
    wezterm:        ["wezterm", "start", "--", "bash", launcherPath],
    "gnome-terminal": ["gnome-terminal", "--", "bash", launcherPath],
    konsole:        ["konsole", "-e", "bash", launcherPath],
    xterm:          ["xterm", "-e", "bash", launcherPath],
  };
  const cmd = linuxCommands[terminalId];
  if (cmd) {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  }
}

export const taskActionsRouter = router({
  run: publicProcedure
    .input(
      z.object({
        prompt: z.string().min(1),
        branch: z.string().default("main"),
        provider: z.string().optional(),
        model: z.string().optional(),
        maxTurns: z.number().optional(),
        allowedTools: z.array(z.string()).optional(),
        networkPolicy: z.enum(["none", "strict"]).optional(),
        allowedHosts: z.string().optional(), // comma-separated extra bypass hosts
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const serverConfig = getServerConfig();
      const taskId = crypto.randomUUID();
      const worktreePrefix = serverConfig.worktreePrefix;
      const projectRoot = serverConfig.projectRoot;
      const worktree = `${worktreePrefix}${taskId}`;
      const logPath = join(projectRoot, ".ysa", "logs", `${taskId}.log`);

      const networkPolicy = input.networkPolicy ?? "none";

      const { scopedRules, bypassHosts: extraBypass } = parseAllowedHosts(input.allowedHosts);
      const bypassHosts = [...getProvider(input.provider ?? "claude").bypassHosts, ...extraBypass];

      // Ensure proxy is running if strict mode
      if (networkPolicy === "strict") {
        await ensureProxy(scopedRules.length > 0 ? scopedRules : undefined, bypassHosts, serverConfig.port);
      }

      // Insert queued task
      db.insert(schema.tasks)
        .values({
          task_id: taskId,
          prompt: input.prompt,
          status: "queued",
          branch: input.branch,
          worktree,
          log_path: logPath,
          network_policy: networkPolicy,
          provider: input.provider ?? "claude",
          model: input.model ?? null,
          allowed_hosts: input.allowedHosts ?? null,
          started_at: new Date().toISOString(),
        })
        .run();

      // Store prompt for container to fetch (with result + abort instructions appended)
      const promptKey = taskId;
      await fetch(`http://localhost:${serverConfig.port}/api/prompt/${promptKey}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getOrCreateAuthToken()}` },
        body: wrapPrompt(input.prompt),
      });
      const promptUrl = `http://host.containers.internal:${serverConfig.port}/api/prompt/${promptKey}`;

      const config: RunConfig = {
        taskId,
        prompt: input.prompt,
        branch: input.branch,
        projectRoot,
        worktreePrefix,
        provider: input.provider ?? "claude",
        model: input.model,
        maxTurns: input.maxTurns,
        allowedTools: input.allowedTools,
        networkPolicy,
        promptUrl,
      };

      // Update to running
      db.update(schema.tasks)
        .set({ status: "running", updated_at: new Date().toISOString() })
        .where(eq(schema.tasks.task_id, taskId))
        .run();

      // Fire-and-forget — update DB when done (skip if already stopped)
      runTask(config)
        .then((result) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: result.status,
              session_id: result.session_id,
              error: result.error,
              failure_reason: result.failure_reason,
              log_path: result.log_path,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, taskId))
            .run();
        })
        .catch((err) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: "failed",
              error: err.message,
              failure_reason: "infrastructure",
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, taskId))
            .run();
        });

      return { task_id: taskId };
    }),

  stop: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();

      const sessionId = await stopContainer(input.taskId, { logPath: task?.log_path ?? undefined });
      db.update(schema.tasks)
        .set({
          status: "stopped",
          session_id: sessionId,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();
      return { ok: true };
    }),

  relaunch: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error("Task not found");
      if (!["failed", "stopped"].includes(task.status)) {
        throw new Error(`Cannot relaunch task in status: ${task.status}`);
      }

      // Reset status
      db.update(schema.tasks)
        .set({
          status: "running",
          error: null,
          failure_reason: null,
          finished_at: null,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();

      const serverConfig = getServerConfig();

      // Store prompt for container to fetch (with result + abort instructions appended)
      await fetch(`http://localhost:${serverConfig.port}/api/prompt/${input.taskId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getOrCreateAuthToken()}` },
        body: wrapPrompt(task.prompt),
      });
      const promptUrl = `http://host.containers.internal:${serverConfig.port}/api/prompt/${input.taskId}`;

      const taskNetworkPolicy = (task.network_policy ?? "none") as "none" | "strict";
      if (taskNetworkPolicy === "strict") {
        const { scopedRules, bypassHosts: extraBypass } = parseAllowedHosts(task.allowed_hosts);
        await ensureProxy(scopedRules.length > 0 ? scopedRules : undefined, [...getProvider(task.provider ?? "claude").bypassHosts, ...extraBypass], serverConfig.port);
      }

      const config: RunConfig = {
        taskId: input.taskId,
        prompt: task.prompt,
        branch: task.branch,
        projectRoot: serverConfig.projectRoot,
        worktreePrefix: serverConfig.worktreePrefix,
        provider: task.provider ?? "claude",
        model: task.model ?? undefined,
        networkPolicy: taskNetworkPolicy,
        promptUrl,
      };

      runTask(config)
        .then((result) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: result.status,
              session_id: result.session_id,
              error: result.error,
              failure_reason: result.failure_reason,
              log_path: result.log_path,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        })
        .catch((err) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: "failed",
              error: err.message,
              failure_reason: "infrastructure",
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        });

      return { ok: true };
    }),

  continue: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error("Task not found");
      if (task.failure_reason !== "max_turns" && task.status !== "stopped") {
        throw new Error("Continue is only available for stopped or max_turns tasks");
      }
      if (!task.session_id) throw new Error("No session_id to resume");

      db.update(schema.tasks)
        .set({
          status: "running",
          error: null,
          failure_reason: null,
          finished_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();

      const serverConfig = getServerConfig();
      const continueNetworkPolicy = (task.network_policy ?? "none") as "none" | "strict";
      if (continueNetworkPolicy === "strict") {
        const { scopedRules, bypassHosts: extraBypass } = parseAllowedHosts(task.allowed_hosts);
        await ensureProxy(scopedRules.length > 0 ? scopedRules : undefined, [...getProvider(task.provider ?? "claude").bypassHosts, ...extraBypass], serverConfig.port);
      }

      const config: RunConfig = {
        taskId: input.taskId,
        prompt: task.prompt,
        branch: task.branch,
        projectRoot: serverConfig.projectRoot,
        worktreePrefix: serverConfig.worktreePrefix,
        provider: task.provider ?? "claude",
        model: task.model ?? undefined,
        resumeSessionId: task.session_id,
        networkPolicy: continueNetworkPolicy,
      };

      runTask(config)
        .then((result) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: result.status,
              session_id: result.session_id,
              error: result.error,
              failure_reason: result.failure_reason,
              log_path: result.log_path,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        })
        .catch((err) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: "failed",
              error: err.message,
              failure_reason: "infrastructure",
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        });

      return { ok: true };
    }),

  refine: publicProcedure
    .input(z.object({ taskId: z.string(), prompt: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error("Task not found");
      if (["running", "queued", "archived"].includes(task.status)) {
        throw new Error(`Cannot refine task in status: ${task.status}`);
      }
      if (!task.session_id) throw new Error("No session_id to resume");

      db.update(schema.tasks)
        .set({
          status: "running",
          error: null,
          failure_reason: null,
          finished_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();

      const serverConfig = getServerConfig();
      const refineNetworkPolicy = (task.network_policy ?? "none") as "none" | "strict";
      if (refineNetworkPolicy === "strict") {
        const { scopedRules, bypassHosts: extraBypass } = parseAllowedHosts(task.allowed_hosts);
        await ensureProxy(scopedRules.length > 0 ? scopedRules : undefined, [...getProvider(task.provider ?? "claude").bypassHosts, ...extraBypass], serverConfig.port);
      }

      const config: RunConfig = {
        taskId: input.taskId,
        prompt: task.prompt,
        branch: task.branch,
        projectRoot: serverConfig.projectRoot,
        worktreePrefix: serverConfig.worktreePrefix,
        provider: task.provider ?? "claude",
        model: task.model ?? undefined,
        resumeSessionId: task.session_id,
        resumePrompt: wrapRefinePrompt(input.prompt),
        networkPolicy: refineNetworkPolicy,
      };

      runTask(config)
        .then((result) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: result.status,
              session_id: result.session_id,
              error: result.error,
              failure_reason: result.failure_reason,
              log_path: result.log_path,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        })
        .catch((err) => {
          const current = db.select().from(schema.tasks).where(eq(schema.tasks.task_id, input.taskId)).get();
          if (current?.status === "stopped") return;
          db.update(schema.tasks)
            .set({
              status: "failed",
              error: err.message,
              failure_reason: "infrastructure",
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where(eq(schema.tasks.task_id, input.taskId))
            .run();
        });

      return { ok: true };
    }),

  archive: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error("Task not found");

      const serverConfig = getServerConfig();
      await teardownContainer(input.taskId);
      await removeWorktree(serverConfig.projectRoot, task.worktree, task.branch);
      db.update(schema.tasks)
        .set({ status: "archived", worktree: "", updated_at: new Date().toISOString() })
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();
      return { ok: true };
    }),

  delete: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const serverConfig = getServerConfig();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (task) {
        await teardownContainer(input.taskId).catch(() => {});
        if (task.worktree) {
          await removeWorktree(serverConfig.projectRoot, task.worktree, task.branch).catch(() => {});
        }
      }
      db.delete(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .run();
      return { ok: true };
    }),

  openTerminal: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const serverConfig = getServerConfig();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.task_id, input.taskId))
        .get();
      if (!task) throw new Error("Task not found");

      // Extract session_id from log if not in DB
      let sessionId = task.session_id;
      if (!sessionId && task.log_path && await fileExists(task.log_path)) {
        const logContent = await readFile(task.log_path, "utf-8");
        const matches = logContent.match(/"session_id":"([^"]*)"/g);
        if (matches) {
          const last = matches[matches.length - 1];
          const id = last.match(/"session_id":"([^"]*)"/)?.[1];
          if (id) sessionId = id;
        }
      }

      const worktree = task.worktree;
      const gitDir = join(serverConfig.projectRoot, ".git");
      const worktreeName = worktree.split("/").pop()!;
      const sessionVolume = `task-session-${input.taskId}`;
      const resumeFlag = sessionId ? `--resume ${sessionId}` : "";

      const taskProvider = task.provider ?? "claude";
      const taskAdapter = getProvider(taskProvider);
      const authEnv = await taskAdapter.getAuthEnv();
      const oauthToken = authEnv.CLAUDE_CODE_OAUTH_TOKEN || "";

      const taskNetPolicy = (task as any).network_policy ?? "none";
      const proxyEnv = (taskNetPolicy === "strict")
        ? `-e HTTP_PROXY=http://host.containers.internal:3128 \\\n  -e HTTPS_PROXY=http://host.containers.internal:3128 \\\n  -e http_proxy=http://host.containers.internal:3128 \\\n  -e https_proxy=http://host.containers.internal:3128 \\\n  --annotation network_policy=${taskNetPolicy}`
        : "";

      if (taskNetPolicy === "strict") {
        const { scopedRules, bypassHosts: extraBypass } = parseAllowedHosts(task.allowed_hosts);
        await ensureProxy(scopedRules.length > 0 ? scopedRules : undefined, [...taskAdapter.bypassHosts, ...extraBypass], serverConfig.port);
      }

      const launchersDir = join(homedir(), ".ysa", "launchers");
      await mkdir(launchersDir, { recursive: true, mode: 0o700 });

      const launcherPath = join(launchersDir, `claude-refine-${input.taskId}.sh`);
      const tokenEnvPath = join(launchersDir, `token-${input.taskId}.env`);

      await writeFile(tokenEnvPath, `CLAUDE_CODE_OAUTH_TOKEN=${shellescape(oauthToken)}\n`, { mode: 0o600 });

      const launcherScript = `#!/bin/bash
set -euo pipefail

# Load credentials and remove the file immediately
# shellcheck source=/dev/null
source ${shellescape(tokenEnvPath)}
rm -f ${shellescape(tokenEnvPath)}

echo -e "\\033[90mStarting sandbox for task ${input.taskId.slice(0, 8)}...\\033[0m"
podman rm -f "refine-${input.taskId}" 2>/dev/null || true
podman run --rm -it \\
  --name "refine-${input.taskId}" \\
  --user 1001:1001 \\
  --network slirp4netns \\
  --add-host host.containers.internal:host-gateway \\
  --cap-drop ALL \\
  --security-opt no-new-privileges \\
  --security-opt seccomp=${shellescape(SECCOMP_PROFILE)} \\
  --read-only \\
  --tmpfs /tmp:rw,nosuid,size=256m \\
  --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \\
  --memory 4g \\
  --pids-limit 512 \\
  --cpus 2 \\
  -e CLAUDE_CODE_OAUTH_TOKEN \\
  ${proxyEnv} \\
  -v ${shellescape(worktree)}:/workspace:rw \\
  -v ${shellescape(gitDir)}:/repo.git:rw \\
  --mount "type=volume,src=${sessionVolume},dst=/home/agent" \\
  sandbox-claude \\
  -c "
    if [ ! -f /home/agent/.claude/settings.json ] && [ -f /etc/claude-defaults/settings.json ]; then
      mkdir -p /home/agent/.claude/hooks
      cp /etc/claude-defaults/settings.json /home/agent/.claude/settings.json
      cp /etc/claude-defaults/hooks/sandbox-guard.sh /home/agent/.claude/hooks/sandbox-guard.sh 2>/dev/null
      chmod +x /home/agent/.claude/hooks/sandbox-guard.sh 2>/dev/null
    fi
    if [ -f /home/agent/.claude.json ]; then
      jq '.hasCompletedOnboarding = true | .projects[\\\\"/workspace\\\\"].hasTrustDialogAccepted = true' /home/agent/.claude.json > /tmp/cj.json 2>/dev/null && mv /tmp/cj.json /home/agent/.claude.json
    else
      echo '{\\\"hasCompletedOnboarding\\\":true,\\\"projects\\\":{\\\"\/workspace\\\":{\\\"hasTrustDialogAccepted\\\":true}}}' > /home/agent/.claude.json
    fi

    echo 'gitdir: /repo.git/worktrees/${worktreeName}' > /workspace/.git
    if [ -w /repo.git/worktrees/${worktreeName}/gitdir ]; then
      echo '/workspace/.git' > /repo.git/worktrees/${worktreeName}/gitdir
    fi

    echo -e '\\033[90mLaunching Claude...\\033[0m'
    claude ${resumeFlag} --add-dir /workspace --dangerously-skip-permissions
  "

# Restore host worktree pointer
echo "gitdir: ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}" > ${shellescape(worktree)}/.git
echo ${shellescape(worktree)}/.git > ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}/gitdir
`;

      await writeFile(launcherPath, launcherScript, { mode: 0o700 });

      const { getConfig } = await import("./config-store");
      const terminalId = getConfig().preferred_terminal ?? "terminal";
      await openInTerminal(launcherPath, input.taskId.slice(0, 8), terminalId);

      setTimeout(async () => {
        try { await unlink(launcherPath); } catch {}
      }, 3000);

      return { ok: true, session_id: sessionId, launcherPath };
    }),
});
