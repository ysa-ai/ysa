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

describe("Containerfiles — mise", () => {
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
