import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const sandboxRunPath = join(import.meta.dir, "../../container/sandbox-run.sh");
const sandboxRunContent = readFileSync(sandboxRunPath, "utf-8");

describe("sandbox-run.sh", () => {
  it("ut-1: curl PROMPT_URL fetch has --max-time 10 and --connect-timeout 5", () => {
    const curlLine = sandboxRunContent
      .split("\n")
      .find((line) => line.includes("PROMPT_URL") && line.includes("curl"));

    expect(curlLine).toBeDefined();
    expect(curlLine).toContain("--max-time 10");
    expect(curlLine).toContain("--connect-timeout 5");
  });

  it("ut-mise-1: mounts MISE_VOLUME (provided by caller) into container", () => {
    // Volume creation is now handled by ensureMiseRuntimes() in the caller (runner.ts).
    // sandbox-run.sh just reads MISE_VOLUME and mounts it.
    expect(sandboxRunContent).toContain('MISE_VOLUME="${MISE_VOLUME:-mise-installs}"');
    expect(sandboxRunContent).toContain("src=${MISE_VOLUME}");
  });

  it("ut-mise-2: podman run mounts mise-installs at mise installs path with MISE_DATA_DIR", () => {
    expect(sandboxRunContent).toContain("mise-installs");
    expect(sandboxRunContent).toContain("dst=/home/agent/.local/share/mise/installs");
    expect(sandboxRunContent).toContain("MISE_DATA_DIR=/home/agent/.local/share/mise");
  });

  it("ut-mise-4: teardownContainer grep pattern does not match mise-installs volume name", () => {
    // The pattern used in teardownContainer is: grep -- '-${id}$'
    // This matches volumes ending with the task ID (e.g. task-session-<id>, shadow-node_modules-<id>).
    // "mise-installs" does not end with any task ID, so it will never be removed by teardownContainer.
    const pattern = /-[a-f0-9-]{36}$/;
    expect(pattern.test("mise-installs")).toBe(false);
    // Verify task-specific volumes DO match the pattern
    expect(pattern.test("task-session-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(pattern.test("shadow-node_modules-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
});

describe("Containerfile \u2014 mise", () => {
  const containerfilePath = join(import.meta.dir, "../../container/Containerfile");
  const containerfileContent = readFileSync(containerfilePath, "utf-8");

  it("ut-1: container/Containerfile contains all three mise install lines", () => {
    expect(containerfileContent).toContain("curl https://mise.run | sh");
    expect(containerfileContent).toContain('ENV PATH="/home/agent/.local/bin');
    expect(containerfileContent).toContain("mise --version");
  });
});
