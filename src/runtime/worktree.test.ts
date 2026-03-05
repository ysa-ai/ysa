import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { withFileLock, createWorktree } from "./worktree";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "worktree-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("ut-1: rejects with timeout error when lock cannot be acquired within timeoutMs", async () => {
    const lockPath = join(tmpDir, "test.lock");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Acquire the lock and hold it indefinitely
    const holder = withFileLock(lockPath, () => held);

    // Give the holder time to acquire the lock
    await Bun.sleep(50);

    // A concurrent acquisition with a short timeout must reject
    await expect(
      withFileLock(lockPath, async () => "second", 100),
    ).rejects.toThrow("Could not acquire worktree lock after 100ms");

    // Release the original holder
    release();
    await holder;
  });
});

describe("createWorktree", () => {
  it("ut-2: concurrent calls create the initial commit exactly once", async () => {
    const repoDir = join(tmpDir, "repo");
    await mkdir(repoDir, { recursive: true });

    // Initialize a git repo with no commits
    const initProc = Bun.spawn(
      ["bash", "-c", "git init && git config user.email test@test.com && git config user.name Test"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    await initProc.exited;

    const wt1 = join(tmpDir, "wt1");
    const wt2 = join(tmpDir, "wt2");

    // Run both concurrently — the lock ensures only one initial commit is created
    const [r1, r2] = await Promise.all([
      createWorktree(repoDir, wt1, "branch-task-1"),
      createWorktree(repoDir, wt2, "branch-task-2"),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Verify exactly one initial commit exists
    const logProc = Bun.spawn(["git", "log", "--oneline"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = await new Response(logProc.stdout).text();
    await logProc.exited;

    const commits = log.trim().split("\n").filter(Boolean);
    expect(commits).toHaveLength(1);
  });
});
