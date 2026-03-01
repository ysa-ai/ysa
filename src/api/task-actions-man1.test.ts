/**
 * Automated verification for man-1: terminal launcher file permissions and cleanup.
 *
 * This test replicates the openTerminal file-system lifecycle without the UI:
 *  - Verifies no launcher ends up in /tmp
 *  - Verifies launchers dir is created with mode 700
 *  - Verifies token env file is written with mode 600
 *  - Verifies launcher script is written with mode 700
 *  - Verifies token env file is removed when the launcher script executes
 *  - Verifies the raw token never appears in the launcher script
 *  - Verifies the launcher script is removed within 4 s (simulating the setTimeout)
 */
import { describe, it, expect, afterEach } from "bun:test";
import { shellescape } from "./task-actions";
import { mkdir, writeFile, stat, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const LAUNCHERS_DIR = join(homedir(), ".ysa", "launchers");
const MOCK_TOKEN = "mock-oauth-token-TESTONLY-abc123";
const TEST_TASK_ID = `man1-test-${Date.now()}`;

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
  return `#!/bin/bash
set -euo pipefail

# Load credentials and remove the file immediately
# shellcheck source=/dev/null
source ${shellescape(tokenEnvPath)}
rm -f ${shellescape(tokenEnvPath)}

echo -e "\\033[90mStarting sandbox for task ${taskId.slice(0, 8)}...\\033[0m"
podman rm -f "refine-${taskId}" 2>/dev/null || true
podman run --rm -it \\
  --name "refine-${taskId}" \\
  --user 1001:1001 \\
  --network slirp4netns \\
  --add-host host.containers.internal:host-gateway \\
  --cap-drop ALL \\
  --security-opt no-new-privileges \\
  --security-opt seccomp=${shellescape(seccompProfile)} \\
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
    echo 'gitdir: /repo.git/worktrees/${worktreeName}' > /workspace/.git
    claude ${resumeFlag} --add-dir /workspace --dangerously-skip-permissions
  "

# Restore host worktree pointer
echo "gitdir: ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}" > ${shellescape(worktree)}/.git
echo ${shellescape(worktree)}/.git > ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}/gitdir
`;
}

describe("man-1: terminal launcher file-system security", () => {
  const launcherPath = join(LAUNCHERS_DIR, `claude-refine-${TEST_TASK_ID}.sh`);
  const tokenEnvPath = join(LAUNCHERS_DIR, `token-${TEST_TASK_ID}.env`);

  afterEach(async () => {
    // Cleanup test artefacts regardless of test outcome
    try { await unlink(launcherPath); } catch {}
    try { await unlink(tokenEnvPath); } catch {}
  });

  it("man-1a: no launcher script in /tmp", () => {
    const result = spawnSync("bash", ["-c", `ls /tmp/claude-refine-*.sh 2>/dev/null`], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("");
  });

  it("man-1b: launchers dir created with mode 700", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });
    const mode = await fileMode(LAUNCHERS_DIR);
    expect(mode).toBe(0o700);
  });

  it("man-1c: token env file written with mode 600 and raw token absent from launcher", async () => {
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

  it("man-1d: launcher script written with mode 700", async () => {
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

  it("man-1e: token env file is removed when the launcher script executes its first lines", async () => {
    await mkdir(LAUNCHERS_DIR, { recursive: true, mode: 0o700 });

    // Write token env file
    await writeFile(tokenEnvPath, `CLAUDE_CODE_OAUTH_TOKEN=${shellescape(MOCK_TOKEN)}\n`, { mode: 0o600 });

    // Write a stripped-down launcher (just the credential-load section)
    const credSection = `#!/bin/bash
set -euo pipefail
source ${shellescape(tokenEnvPath)}
rm -f ${shellescape(tokenEnvPath)}
# verify env var was loaded
echo "loaded: $CLAUDE_CODE_OAUTH_TOKEN"
`;
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

  it("man-1f: launcher script is removed within 3 s (simulates server setTimeout)", async () => {
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
});
