import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const seccompPath = join(import.meta.dir, "../../container/seccomp.json");
const seccomp = JSON.parse(readFileSync(seccompPath, "utf-8"));

describe("seccomp profile", () => {
  it("ut-1: vfork, symlink, link are not in any SCMP_ACT_ALLOW syscall list", () => {
    // symlinkat and linkat are allowed — needed by git for atomic file ops and hardlinks.
    const forbidden = ["vfork", "symlink", "link"];
    const allowedSyscalls: string[] = [];

    for (const rule of seccomp.syscalls) {
      if (rule.action === "SCMP_ACT_ALLOW") {
        for (const name of rule.names) {
          allowedSyscalls.push(name);
        }
      }
    }

    for (const syscall of forbidden) {
      expect(allowedSyscalls).not.toContain(syscall);
    }
  });

  it("ut-2: clone rule args[0].valueTwo equals 2114060288 (CLONE_NEWNS included in blocked-flag mask)", () => {
    const cloneRule = seccomp.syscalls.find(
      (r: any) => r.action === "SCMP_ACT_ALLOW" && r.names.includes("clone")
    );

    expect(cloneRule).toBeDefined();
    expect(cloneRule.args).toBeDefined();
    expect(cloneRule.args[0].valueTwo).toBe(2114060288);
  });
});
