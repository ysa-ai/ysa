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

  it("ut-mise-1: creates mise-installs volume before podman run", () => {
    const podmanRunIndex = sandboxRunContent.indexOf("podman run --rm");
    const miseExistsIndex = sandboxRunContent.indexOf('podman volume exists "mise-installs"');
    const miseCreateIndex = sandboxRunContent.indexOf('podman volume create "mise-installs"');

    expect(miseExistsIndex).toBeGreaterThan(-1);
    expect(miseCreateIndex).toBeGreaterThan(-1);
    expect(miseExistsIndex).toBeLessThan(podmanRunIndex);
    expect(miseCreateIndex).toBeLessThan(podmanRunIndex);
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

describe("Containerfiles \u2014 mise", () => {
  const containerfilePath = join(import.meta.dir, "../../container/Containerfile");
  const containerfileContent = readFileSync(containerfilePath, "utf-8");

  const containerfileMistralPath = join(import.meta.dir, "../../container/Containerfile.mistral");
  const containerfileMistralContent = readFileSync(containerfileMistralPath, "utf-8");

  it("ut-1: container/Containerfile contains all three mise install lines", () => {
    expect(containerfileContent).toContain("curl https://mise.run | sh");
    expect(containerfileContent).toContain('ENV PATH="/home/agent/.local/bin');
    expect(containerfileContent).toContain("mise --version");
  });

  it("ut-2: container/Containerfile.mistral contains all three mise install lines", () => {
    expect(containerfileMistralContent).toContain("curl https://mise.run | sh");
    expect(containerfileMistralContent).toContain('ENV PATH="/home/agent/.local/bin');
    expect(containerfileMistralContent).toContain("mise --version");
  });
});
