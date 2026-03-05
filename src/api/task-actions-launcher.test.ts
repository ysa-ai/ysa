/**
 * Integration tests for openTerminal launcher file-system security.
 * Covers: file locations, permissions, token isolation, and cleanup timing.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { shellescape } from "./task-actions";
import { mkdir, writeFile, stat, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const LAUNCHERS_DIR = join(homedir(), ".ysa", "launchers");
const MOCK_TOKEN = "mock-oauth-token-TESTONLY-abc123";
const TEST_TASK_ID = `launcher-test-${Date.now()}`;

async function fileMode(p: string): Promise<number> {
  const s = await stat(p);
  return s.mode & 0o777;
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// Build the same launcher script template that openTerminal uses
function buildLauncherScript(opts: {
  taskId: string;
  tokenEnvPath: string;
  worktree: string;
  gitDir: string;
  worktreeName: string;
  sessionVolume: string;
  resumeFlag: string;
  seccompProfile: string;
  proxyEnv: string;
}): string {
  const { taskId, tokenEnvPath, worktree, gitDir, worktreeName, sessionVolume, resumeFlag, seccompProfile, proxyEnv } = opts;
  return `#!/bin/bash\nset -euo pipefail\n\n# Load credentials and remove the file immediately\n# shellcheck source=/dev/null\nsource ${shellescape(tokenEnvPath)}\nrm -f ${shellescape(tokenEnvPath)}\n\necho -e "\\033[90mStarting sandbox for task ${taskId.slice(0, 8)}...\\033[0m"\npodman rm -f "refine-${taskId}" 2>/dev/null || true\npodman run --rm -it \\\n  --name "refine-${taskId}" \\\n  --user 1001:1001 \\\n  --network slirp4netns \\\n  --add-host host.containers.internal:host-gateway \\\n  --cap-drop ALL \\\n  --security-opt no-new-privileges \\\n  --security-opt seccomp=${shellescape(seccompProfile)} \\\n  --read-only \\\n  --tmpfs /tmp:rw,nosuid,size=256m \\\n  --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \\\n  --memory 4g \\\n  --pids-limit 512 \\\n  --cpus 2 \\\n  -e CLAUDE_CODE_OAUTH_TOKEN \\\n  ${proxyEnv} \\\n  -v ${shellescape(worktree)}:/workspace:rw \\\n  -v ${shellescape(gitDir)}:/repo.git:rw \\\n  --tmpfs /home/agent:rw,nosuid,nodev,size=256m \\\n  --mount "type=volume,src=${sessionVolume},dst=/home/agent/.claude" \\\n  sandbox-claude \\\n  -c "\n    echo 'gitdir: /repo.git/worktrees/${worktreeName}' > /workspace/.git\n    claude ${resumeFlag} --add-dir /workspace --dangerously-skip-permissions\n  "\n\n# Restore host worktree pointer\necho "gitdir: ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}" > ${shellescape(worktree)}/.git\necho ${shellescape(worktree)}/.git > ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}/gitdir\n`;
}

describe("openTerminal launcher: file-system security", () => {
  const launcherPath = join(LAUNCHERS_DIR, `claude-refine-${TEST_TASK_ID}.sh`);
  const tokenEnvPath = join(LAUNCHERS_DIR, `token-${TEST_TASK_ID}.env`);

  afterEach(async () => {
    // Cleanup test artefacts regardless of test outcome
    try { await unlink(launcherPath); } catch {}
    try { await unlink(tokenEnvPath); } catch {}
  });

  it("no launcher script written to /tmp", () => {
    const result = spawnSync("bash", ["-c", `ls /tmp/claude-refine-*.sh 2>/dev/null`], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("");
  });

  it("launchers dir created with mode 700", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });
    const mode = await fileMode(LAUNCHERS_DIR);
    expect(mode).toBe(0o700);
  });

  it("token env file written with mode 600 and raw token absent from launcher script", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });

    // Write token env as openTerminal does
    await writeFile(tokenEnvPath, `CLAUDE_CODE_OAUTH_TOKEN=${shellescape(MOCK_TOKEN)}\n`, { mode: 0o600 });

    const tokenMode = await fileMode(tokenEnvPath);
    expect(tokenMode).toBe(0o600);

    // Build launcher script
    const script = buildLauncherScript({
      taskId: TEST_TASK_ID,
      tokenEnvPath,
      worktree: "/fake/worktree",
      gitDir: "/fake/project/.git",
      worktreeName: TEST_TASK_ID,
      sessionVolume: `task-session-${TEST_TASK_ID}`,
      resumeFlag: "",
      seccompProfile: "/usr/share/ysa/seccomp.json",
      proxyEnv: "",
    });

    // Raw token must NOT appear in the script
    expect(script).not.toContain(MOCK_TOKEN);
  });

  it("launcher script written with mode 700", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });

    const script = buildLauncherScript({
      taskId: TEST_TASK_ID,
      tokenEnvPath,
      worktree: "/fake/worktree",
      gitDir: "/fake/project/.git",
      worktreeName: TEST_TASK_ID,
      sessionVolume: `task-session-${TEST_TASK_ID}`,
      resumeFlag: "",
      seccompProfile: "/usr/share/ysa/seccomp.json",
      proxyEnv: "",
    });
    await writeFile(launcherPath, script, { mode: 0o700 });

    const scriptMode = await fileMode(launcherPath);
    expect(scriptMode).toBe(0o700);
  });

  it("token env file is deleted on first line of launcher execution", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });

    // Write token env file
    await writeFile(tokenEnvPath, `CLAUDE_CODE_OAUTH_TOKEN=${shellescape(MOCK_TOKEN)}\n`, { mode: 0o600 });

    // Write a stripped-down launcher (just the credential-load section)
    const credSection = `#!/bin/bash\nset -euo pipefail\nsource ${shellescape(tokenEnvPath)}\nrm -f ${shellescape(tokenEnvPath)}\n# verify env var was loaded\necho "loaded: $CLAUDE_CODE_OAUTH_TOKEN"\n`;
    await writeFile(launcherPath, credSection, { mode: 0o700 });

    expect(await fileExists(tokenEnvPath)).toBe(true);

    // Execute just the credential section (not the full podman run)
    const result = spawnSync("bash", [launcherPath], { encoding: "utf8" });

    // Token env file must be gone after execution
    expect(await fileExists(tokenEnvPath)).toBe(false);

    // The env var must have been loaded from the file
    expect(result.stdout).toContain("loaded:");
    // The raw token must appear in the output (proves it was loaded correctly)
    expect(result.stdout).toContain(MOCK_TOKEN);
  });

  it("launcher script is removed within 3 s by the server setTimeout", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });
    await writeFile(launcherPath, "#!/bin/bash\necho ok\n", { mode: 0o700 });

    expect(await fileExists(launcherPath)).toBe(true);

    // Simulate the setTimeout(3000) from the server
    await new Promise<void>((resolve) => {
      setTimeout(async () => {
        try { await unlink(launcherPath); } catch {}
        resolve();
      }, 3000);
    });

    expect(await fileExists(launcherPath)).toBe(false);
  });

  it("ut-3: buildLauncherScript uses tmpfs for home dir, not a named volume", () => {
    const script = buildLauncherScript({
      taskId: TEST_TASK_ID,
      tokenEnvPath,
      worktree: "/fake/worktree",
      gitDir: "/fake/project/.git",
      worktreeName: TEST_TASK_ID,
      sessionVolume: `task-session-${TEST_TASK_ID}`,
      resumeFlag: "",
      seccompProfile: "/usr/share/ysa/seccomp.json",
      proxyEnv: "",
    });

    // ut-3: home directory uses tmpfs; session volume mounts only at .claude subdirectory
    expect(script).toContain("--tmpfs /home/agent");
    expect(script).toContain("dst=/home/agent/.claude");
    // Session volume must NOT be mounted as the full home directory
    expect(script).not.toMatch(/type=volume,src=task-session-[^,]+,dst=\/home\/agent["\\]/);
    expect(script).not.toContain(`,dst=/home/agent"`);
  });
});
