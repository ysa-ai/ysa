import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const TEST_BASE = join(tmpdir(), `ysa-audit-test-${process.pid}`);
const AUDIT_LOG = join(TEST_BASE, ".ysa", "audit.log");

process.env.YSA_HOME = TEST_BASE;

beforeAll(async () => {
  await mkdir(join(TEST_BASE, ".ysa"), { recursive: true });
});

afterAll(async () => {
  delete process.env.YSA_HOME;
  await rm(TEST_BASE, { recursive: true, force: true });
});

beforeEach(async () => {
  try { await rm(AUDIT_LOG, { force: true }); } catch {}
});

const { writeAuditLog } = await import("./audit");

// Helper: wait for the async appendFile to complete
async function waitForLog(minLines = 1): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    try {
      const content = await readFile(AUDIT_LOG, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length >= minLines) return lines;
    } catch {}
    await Bun.sleep(20);
  }
  return [];
}

describe("writeAuditLog", () => {
  it("ut-1: appends a valid NDJSON line with ts, action, and data fields", async () => {
    writeAuditLog("task.create", { task_id: "abc123", branch: "main", provider: "claude", model: null, network_policy: "none" });

    const lines = await waitForLog(1);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(typeof parsed.ts).toBe("string");
    // Valid ISO-8601
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
    expect(parsed.action).toBe("task.create");
    expect(parsed.task_id).toBe("abc123");
    expect(parsed.branch).toBe("main");
    expect(parsed.provider).toBe("claude");
    expect(parsed.network_policy).toBe("none");
  });

  it("ut-1: calling twice produces two lines", async () => {
    writeAuditLog("task.stop", { task_id: "aaa" });
    writeAuditLog("task.stop", { task_id: "bbb" });

    const lines = await waitForLog(2);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.task_id).toBe("aaa");
    expect(second.task_id).toBe("bbb");
  });

  it("ut-2: task.create payload does not include a prompt field", async () => {
    writeAuditLog("task.create", { task_id: "t1", branch: "main", provider: "claude", model: null, network_policy: "none" });

    const lines = await waitForLog(1);
    const parsed = JSON.parse(lines[0]);
    expect("prompt" in parsed).toBe(false);
  });

  it("ut-2: config.setApiKey payload includes provider and cleared, but not value", async () => {
    writeAuditLog("config.setApiKey", { provider: "anthropic", cleared: false });

    const lines = await waitForLog(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.cleared).toBe(false);
    expect("value" in parsed).toBe(false);
  });

  it("ut-2: config.set payload contains key names only", async () => {
    writeAuditLog("config.set", { keys: ["default_model", "preferred_terminal"] });

    const lines = await waitForLog(1);
    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.keys).toContain("default_model");
    expect(parsed.keys).toContain("preferred_terminal");
  });

  it("ut-3: does not throw when directory is not writable (simulated via bad path)", async () => {
    const origHome = process.env.YSA_HOME;
    process.env.YSA_HOME = "/proc/does-not-exist-readonly-path";

    // Should not throw
    expect(() => writeAuditLog("task.create", { task_id: "x" })).not.toThrow();

    // Restore
    process.env.YSA_HOME = origHome;

    // Give time for the async fire-and-forget to settle
    await Bun.sleep(100);
  });
});
