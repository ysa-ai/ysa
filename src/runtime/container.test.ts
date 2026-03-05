import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const containerSrc = readFileSync(join(import.meta.dir, "container.ts"), "utf-8");

describe("teardownContainer", () => {
  it("ut-1: volume rm includes node-modules-${id} but not task-session-${id}", () => {
    // Find the podman volume rm line(s) inside teardownContainer
    const teardownMatch = containerSrc.match(
      /export async function teardownContainer[\s\S]*?^}/m
    );
    expect(teardownMatch).not.toBeNull();
    const teardownBody = teardownMatch![0];

    expect(teardownBody).toContain("node-modules-");
    expect(teardownBody).not.toContain("task-session-");
  });
});
