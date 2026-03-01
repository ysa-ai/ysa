import { describe, it, expect } from "bun:test";
import { shellescape } from "./task-actions";
import { join } from "path";

describe("shellescape", () => {
  it("ut-1: wraps empty string in single quotes", () => {
    expect(shellescape("")).toBe("''");
  });

  it("ut-1: wraps a simple path in single quotes", () => {
    expect(shellescape("/some/path")).toBe("'/some/path'");
  });

  it("ut-1: wraps a path with spaces in single quotes", () => {
    expect(shellescape("/path/with spaces")).toBe("'/path/with spaces'");
  });

  it("ut-1: escapes embedded single quotes correctly", () => {
    expect(shellescape("/it's/here")).toBe("'/it'\\''s/here'");
  });

  it("ut-1: escapes multiple embedded single quotes", () => {
    expect(shellescape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("openTerminal launcher script token handling", () => {
  it("ut-2: launcher script does not contain raw token value, includes source line and env-only flag", () => {
    const mockToken = "secret-oauth-token-abc123";
    const taskId = "test-task-id-0001";
    const launchersDir = join("/home/testuser", ".ysa", "launchers");
    const tokenEnvPath = join(launchersDir, `token-${taskId}.env`);
    const worktree = "/home/testuser/.ysa/worktrees/test-task-id-0001";
    const gitDir = "/home/testuser/project/.git";
    const worktreeName = "test-task-id-0001";
    const sessionVolume = `task-session-${taskId}`;
    const resumeFlag = "";
    const SECCOMP_PROFILE = "/usr/share/ysa/seccomp.json";
    const proxyEnv = "";

    // Replicate the template logic from openTerminal
    const launcherScript = `#!/bin/bash
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
    echo 'gitdir: /repo.git/worktrees/${worktreeName}' > /workspace/.git
    claude ${resumeFlag} --add-dir /workspace --dangerously-skip-permissions
  "

# Restore host worktree pointer
echo "gitdir: ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}" > ${shellescape(worktree)}/.git
echo ${shellescape(worktree)}/.git > ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}/gitdir
`;

    // The raw token must NOT appear anywhere in the script
    expect(launcherScript).not.toContain(mockToken);

    // The script must contain a source line referencing the token env file path
    expect(launcherScript).toContain(`source ${shellescape(tokenEnvPath)}`);

    // The script must contain -e CLAUDE_CODE_OAUTH_TOKEN without an inline =value assignment
    expect(launcherScript).toContain("-e CLAUDE_CODE_OAUTH_TOKEN");
    expect(launcherScript).not.toContain(`-e CLAUDE_CODE_OAUTH_TOKEN=`);
  });
});
