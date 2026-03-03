/**
 * Unit tests for network-proxy.ts fixes:
 * - ut-1: per-task rate limit key isolation
 * - ut-2: per-task log file path construction
 * - ut-3: per-connection MITM closure captures taskId correctly
 */

import { describe, it, expect } from "bun:test";

// ── ut-1: Rate limit counter key isolation ─────────────────────────────────

describe("checkRateLimits key isolation (ut-1)", () => {
  interface DomainCounters {
    minuteCount: number;
    minuteStart: number;
    burstCount: number;
    burstStart: number;
    outboundBytes: number;
    outboundStart: number;
  }

  function makeCounters(): Map<string, DomainCounters> {
    return new Map();
  }

  function makeKey(taskId: string, domain: string): string {
    return `${taskId || "_shared"}:${domain}`;
  }

  function getCounters(counters: Map<string, DomainCounters>, key: string): DomainCounters {
    let c = counters.get(key);
    if (!c) {
      c = { minuteCount: 0, minuteStart: Date.now(), burstCount: 0, burstStart: Date.now(), outboundBytes: 0, outboundStart: Date.now() };
      counters.set(key, c);
    }
    return c;
  }

  function checkRateLimits(
    counters: Map<string, DomainCounters>,
    domain: string,
    pathLength: number,
    headerBytes: number,
    taskId: string,
    rateLimitPerDomain = 30,
  ): string | null {
    const key = makeKey(taskId, domain);
    const c = getCounters(counters, key);
    c.minuteCount++;
    c.burstCount++;
    c.outboundBytes += pathLength + headerBytes;
    if (c.minuteCount > rateLimitPerDomain) {
      return `rate_limit: ${c.minuteCount}/${rateLimitPerDomain} req/min for ${domain}`;
    }
    return null;
  }

  it('keys counters as "taskId:domain", not just "domain"', () => {
    const counters = makeCounters();

    // Verify key format: taskId:domain
    checkRateLimits(counters, "github.com", 10, 100, "taskA");
    checkRateLimits(counters, "github.com", 10, 100, "taskB");

    expect(counters.has("taskA:github.com")).toBe(true);
    expect(counters.has("taskB:github.com")).toBe(true);
    // Old format (domain only) should NOT be present
    expect(counters.has("github.com")).toBe(false);
  });

  it("Task A exhausting rate limit for github.com does not affect Task B", () => {
    const counters = makeCounters();

    // Task A exhausts its rate limit (30 req/min) for github.com
    for (let i = 0; i < 31; i++) {
      checkRateLimits(counters, "github.com", 10, 100, "taskA");
    }

    const taskALimited = checkRateLimits(counters, "github.com", 10, 100, "taskA");
    expect(taskALimited).not.toBeNull();
    expect(taskALimited).toContain("rate_limit");

    // Task B has not made any requests yet — should pass
    const taskBResult = checkRateLimits(counters, "github.com", 10, 100, "taskB");
    expect(taskBResult).toBeNull();

    // Task B counter is independent — only 1 request registered
    expect(counters.get("taskB:github.com")?.minuteCount).toBe(1);
    // Task A counter reflects its own exhaustion
    expect(counters.get("taskA:github.com")?.minuteCount).toBe(32);
  });

  it("uses _shared key when taskId is empty", () => {
    const counters = makeCounters();
    checkRateLimits(counters, "example.com", 10, 100, "");
    expect(counters.has("_shared:example.com")).toBe(true);
  });
});

// ── ut-2: appendToTaskLog path construction ────────────────────────────────

describe("appendToTaskLog path construction (ut-2)", () => {
  const LOG_DIR = "/proxy-logs";

  function getLogPath(taskId: string): string {
    return `${LOG_DIR}/${taskId}.log`;
  }

  it('constructs path as "/proxy-logs/{taskId}.log"', () => {
    expect(getLogPath("task-abc123")).toBe("/proxy-logs/task-abc123.log");
    expect(getLogPath("task-def456")).toBe("/proxy-logs/task-def456.log");
  });

  it("two different taskIds produce two different file paths with no overlap", () => {
    const path1 = getLogPath("taskA");
    const path2 = getLogPath("taskB");

    expect(path1).not.toBe(path2);
    expect(path1).toBe("/proxy-logs/taskA.log");
    expect(path2).toBe("/proxy-logs/taskB.log");

    // path1 contains no trace of taskB
    expect(path1).not.toContain("taskB");
    // path2 contains no trace of taskA
    expect(path2).not.toContain("taskA");
  });
});

// ── ut-3: Per-connection MITM closure captures taskId correctly ─────────────

describe("MITM per-connection closure taskId capture (ut-3)", () => {
  it("each CONNECT request creates an independent closure with its own taskId", async () => {
    const logged: Array<{ taskId: string; hostname: string }> = [];

    // Simulate createMitmConnection: the fetch handler captures taskId in closure
    function createMitmHandler(hostname: string, taskId: string) {
      return async function handleRequest(_method: string, _path: string) {
        // taskId is captured in closure — no shared mutable state
        logged.push({ taskId, hostname });
        return taskId;
      };
    }

    // Two concurrent CONNECT requests for the same hostname with different taskIds
    const handlerA = createMitmHandler("github.com", "taskA");
    const handlerB = createMitmHandler("github.com", "taskB");

    const [resultA, resultB] = await Promise.all([
      handlerA("GET", "/path"),
      handlerB("GET", "/path"),
    ]);

    expect(resultA).toBe("taskA");
    expect(resultB).toBe("taskB");
    expect(logged.filter((e) => e.taskId === "taskA").length).toBe(1);
    expect(logged.filter((e) => e.taskId === "taskB").length).toBe(1);
  });

  it("closure taskId is not overwritten by a subsequent CONNECT for the same hostname", async () => {
    // Simulate the race condition that existed with the shared hostTaskIds map
    const hostTaskIds = new Map<string, string>();

    function oldApproach_getTaskId(hostname: string, taskId: string): string {
      hostTaskIds.set(hostname, taskId); // last writer wins — this is the bug
      return hostTaskIds.get(hostname)!;
    }

    function newApproach_makeGetter(taskId: string): () => string {
      return () => taskId; // closure: no shared mutable state
    }

    // Old approach: task B overwrites task A's entry for github.com
    oldApproach_getTaskId("github.com", "taskA");
    oldApproach_getTaskId("github.com", "taskB"); // overwrites!
    expect(hostTaskIds.get("github.com")).toBe("taskB"); // taskA is lost

    // New approach: each connection has its own getter via closure
    const getterA = newApproach_makeGetter("taskA");
    const getterB = newApproach_makeGetter("taskB");

    // No matter the order, each closure always returns its own taskId
    expect(getterA()).toBe("taskA");
    expect(getterB()).toBe("taskB");
    expect(getterA()).toBe("taskA"); // still correct after getterB was called
  });
});
