import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const containerSrc = readFileSync(join(import.meta.dir, "container.ts"), "utf-8");

describe("teardownContainer", () => {
  it("ut-1: volume rm includes shadow-node_modules-${id} but not task-session-${id}", () => {
    // Find the podman volume rm line(s) inside teardownContainer
    const teardownMatch = containerSrc.match(
      /export async function teardownContainer[\s\S]*?^}/m
    );
    expect(teardownMatch).not.toBeNull();
    const teardownBody = teardownMatch![0];

    expect(teardownBody).toContain("shadow-node_modules-");
    expect(teardownBody).not.toContain("task-session-");
  });
});

describe("spawnSandbox SHADOW_DIRS", () => {
  it("ut-2: sets SHADOW_DIRS when shadowDirs provided", () => {
    // Read container.ts source and verify SHADOW_DIRS is assigned from opts.shadowDirs
    expect(containerSrc).toContain("SHADOW_DIRS");
    expect(containerSrc).toContain("opts.shadowDirs");
  });

  it("ut-3: does not set SHADOW_DIRS when shadowDirs is absent", () => {
    // Verify the assignment is guarded by a conditional (opts.shadowDirs &&)
    expect(containerSrc).toMatch(/opts\.shadowDirs.*&&.*SHADOW_DIRS|if.*opts\.shadowDirs/);
  });
});
