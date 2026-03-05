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
});
