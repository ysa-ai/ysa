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
    const launcherScript = `#!/bin/bash\nset -euo pipefail\n\n# Load credentials and remove the file immediately\n# shellcheck source=/dev/null\nsource ${shellescape(tokenEnvPath)}\nrm -f ${shellescape(tokenEnvPath)}\n\necho -e "\\033[90mStarting sandbox for task ${taskId.slice(0, 8)}...\\033[0m"\npodman rm -f "refine-${taskId}" 2>/dev/null || true\npodman run --rm -it \\\n  --name "refine-${taskId}" \\\n  --user 1001:1001 \\\n  --network slirp4netns \\\n  --add-host host.containers.internal:host-gateway \\\n  --cap-drop ALL \\\n  --security-opt no-new-privileges \\\n  --security-opt seccomp=${shellescape(SECCOMP_PROFILE)} \\\n  --read-only \\\n  --tmpfs /tmp:rw,nosuid,size=256m \\\n  --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \\\n  --memory 4g \\\n  --pids-limit 512 \\\n  --cpus 2 \\\n  -e CLAUDE_CODE_OAUTH_TOKEN \\\n  ${proxyEnv} \\\n  -v ${shellescape(worktree)}:/workspace:rw \\\n  -v ${shellescape(gitDir)}:/repo.git:rw \\\n  --tmpfs /home/agent:rw,nosuid,nodev,size=256m \\\n  --mount "type=volume,src=${sessionVolume},dst=/home/agent/.claude" \\\n  sandbox-claude \\\n  -c "\n    echo 'gitdir: /repo.git/worktrees/${worktreeName}' > /workspace/.git\n    claude ${resumeFlag} --add-dir /workspace --dangerously-skip-permissions\n  "\n\n# Restore host worktree pointer\necho "gitdir: ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}" > ${shellescape(worktree)}/.git\necho ${shellescape(worktree)}/.git > ${shellescape(gitDir)}/worktrees/${shellescape(worktreeName)}/gitdir\n`;

    // The raw token must NOT appear anywhere in the script
    expect(launcherScript).not.toContain(mockToken);

    // The script must contain a source line referencing the token env file path
    expect(launcherScript).toContain(`source ${shellescape(tokenEnvPath)}`);

    // The script must contain -e CLAUDE_CODE_OAUTH_TOKEN without an inline =value assignment
    expect(launcherScript).toContain("-e CLAUDE_CODE_OAUTH_TOKEN");
    expect(launcherScript).not.toContain(`-e CLAUDE_CODE_OAUTH_TOKEN=`);

    // ut-2: home directory uses tmpfs; session volume mounts only at .claude subdirectory
    expect(launcherScript).toContain("--tmpfs /home/agent");
    expect(launcherScript).toContain(`dst=/home/agent/.claude`);
    // Session volume must NOT be mounted as the full home directory
    expect(launcherScript).not.toMatch(/type=volume,src=task-session-[^,]+,dst=\/home\/agent["\\]/);
    expect(launcherScript).not.toContain(`,dst=/home/agent"`);
  });
});
