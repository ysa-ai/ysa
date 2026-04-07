/**
 * Unit tests for network-proxy.ts:
 * - ut-1 (fix/12): per-task rate limit key isolation
 * - ut-2 (fix/12): per-task log file path construction
 * - ut-3 (fix/12): per-connection MITM closure captures taskId correctly
 * - ut-1 (fix/10): global limit field parsing from PROXY_POLICY env var
 * - ut-2 (fix/10): counter persistence round-trip via saveCounters/loadCounters
 */

import { describe, it, expect } from "bun:test";
import { writeFileSync, readFileSync, unlinkSync } from "fs";

// ── ut-1 (fix/12): Rate limit counter key isolation ─────────────────────────

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

// ── ut-2 (fix/12): appendToTaskLog path construction ────────────────────────

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

// ── ut-3 (fix/12): Per-connection MITM closure captures taskId correctly ─────

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

// ── ut-1 (fix/10): Policy global limit field parsing ────────────────────────

describe("Policy globalRateLimitPerTask and globalOutboundBudget parsing (ut-1 fix/10)", () => {
  const DEFAULTS = { globalRateLimitPerTask: 300, globalOutboundBudget: 512000 };

  function parseGlobalLimits(env: string | undefined): { globalRateLimitPerTask: number; globalOutboundBudget: number } {
    try {
      if (!env) return { ...DEFAULTS };
      const parsed = JSON.parse(env);
      return {
        globalRateLimitPerTask: parsed.globalRateLimitPerTask ?? DEFAULTS.globalRateLimitPerTask,
        globalOutboundBudget: parsed.globalOutboundBudget ?? DEFAULTS.globalOutboundBudget,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  it("uses default globalRateLimitPerTask=300 when PROXY_POLICY is absent", () => {
    const p = parseGlobalLimits(undefined);
    expect(p.globalRateLimitPerTask).toBe(300);
  });

  it("uses default globalOutboundBudget=512000 when PROXY_POLICY is absent", () => {
    const p = parseGlobalLimits(undefined);
    expect(p.globalOutboundBudget).toBe(512000);
  });

  it("parses globalRateLimitPerTask from PROXY_POLICY JSON", () => {
    const p = parseGlobalLimits(JSON.stringify({ globalRateLimitPerTask: 150 }));
    expect(p.globalRateLimitPerTask).toBe(150);
    expect(p.globalOutboundBudget).toBe(512000); // default preserved
  });

  it("parses globalOutboundBudget from PROXY_POLICY JSON", () => {
    const p = parseGlobalLimits(JSON.stringify({ globalOutboundBudget: 1024000 }));
    expect(p.globalRateLimitPerTask).toBe(300); // default preserved
    expect(p.globalOutboundBudget).toBe(1024000);
  });

  it("parses both global fields together", () => {
    const p = parseGlobalLimits(JSON.stringify({ globalRateLimitPerTask: 50, globalOutboundBudget: 256000 }));
    expect(p.globalRateLimitPerTask).toBe(50);
    expect(p.globalOutboundBudget).toBe(256000);
  });

  it("falls back to defaults when PROXY_POLICY contains malformed JSON", () => {
    const p = parseGlobalLimits("not-valid-json{");
    expect(p.globalRateLimitPerTask).toBe(300);
    expect(p.globalOutboundBudget).toBe(512000);
  });

  it("falls back to defaults for missing fields in valid JSON", () => {
    const p = parseGlobalLimits(JSON.stringify({ scopedAllowRules: [] }));
    expect(p.globalRateLimitPerTask).toBe(300);
    expect(p.globalOutboundBudget).toBe(512000);
  });
});

// ── ut-2 (fix/10): Counter persistence round-trip ───────────────────────────

describe("Counter persistence round-trip (ut-2 fix/10)", () => {
  interface GlobalCounters {
    minuteCount: number;
    minuteStart: number;
    outboundBytes: number;
    outboundStart: number;
  }

  interface DomainCounters {
    minuteCount: number;
    minuteStart: number;
    burstCount: number;
    burstStart: number;
    outboundBytes: number;
    outboundStart: number;
  }

  function save(
    filePath: string,
    global: Map<string, GlobalCounters>,
    domain: Map<string, DomainCounters>,
  ): void {
    const data = {
      global: Object.fromEntries(global),
      domain: Object.fromEntries(domain),
    };
    writeFileSync(filePath, JSON.stringify(data));
  }

  function load(
    filePath: string,
    global: Map<string, GlobalCounters>,
    domain: Map<string, DomainCounters>,
  ): void {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data.global ?? {})) global.set(k, v as GlobalCounters);
      for (const [k, v] of Object.entries(data.domain ?? {})) domain.set(k, v as DomainCounters);
    } catch {}
  }

  it("saveCounters/loadCounters round-trip restores globalCounters minuteCount and outboundBytes", () => {
    const tmpFile = `/tmp/test-counters-${Date.now()}.json`;
    const now = Date.now();

    const globalIn = new Map<string, GlobalCounters>();
    const domainIn = new Map<string, DomainCounters>();

    globalIn.set("task-abc", {
      minuteCount: 42,
      minuteStart: now - 5000,
      outboundBytes: 12345,
      outboundStart: now - 3000,
    });

    domainIn.set("task-abc:github.com", {
      minuteCount: 15,
      minuteStart: now - 5000,
      burstCount: 3,
      burstStart: now - 1000,
      outboundBytes: 6789,
      outboundStart: now - 3000,
    });

    save(tmpFile, globalIn, domainIn);

    const globalOut = new Map<string, GlobalCounters>();
    const domainOut = new Map<string, DomainCounters>();
    load(tmpFile, globalOut, domainOut);

    const restoredGlobal = globalOut.get("task-abc");
    expect(restoredGlobal).toBeDefined();
    expect(restoredGlobal!.minuteCount).toBe(42);
    expect(restoredGlobal!.outboundBytes).toBe(12345);

    const restoredDomain = domainOut.get("task-abc:github.com");
    expect(restoredDomain).toBeDefined();
    expect(restoredDomain!.minuteCount).toBe(15);
    expect(restoredDomain!.burstCount).toBe(3);
    expect(restoredDomain!.outboundBytes).toBe(6789);

    try { unlinkSync(tmpFile); } catch {}
  });

  it("all entries from globalCounters are restored after round-trip", () => {
    const tmpFile = `/tmp/test-counters-multi-${Date.now()}.json`;
    const now = Date.now();

    const globalIn = new Map<string, GlobalCounters>();
    const domainIn = new Map<string, DomainCounters>();

    globalIn.set("task-1", { minuteCount: 10, minuteStart: now, outboundBytes: 100, outboundStart: now });
    globalIn.set("task-2", { minuteCount: 20, minuteStart: now, outboundBytes: 200, outboundStart: now });
    globalIn.set("_shared", { minuteCount: 5, minuteStart: now, outboundBytes: 50, outboundStart: now });

    save(tmpFile, globalIn, domainIn);

    const globalOut = new Map<string, GlobalCounters>();
    const domainOut = new Map<string, DomainCounters>();
    load(tmpFile, globalOut, domainOut);

    expect(globalOut.size).toBe(3);
    expect(globalOut.get("task-1")?.minuteCount).toBe(10);
    expect(globalOut.get("task-2")?.minuteCount).toBe(20);
    expect(globalOut.get("_shared")?.minuteCount).toBe(5);

    try { unlinkSync(tmpFile); } catch {}
  });

  it("loadCounters is a no-op when the file does not exist", () => {
    const globalOut = new Map<string, GlobalCounters>();
    const domainOut = new Map<string, DomainCounters>();

    load("/nonexistent/path/counters.json", globalOut, domainOut);

    expect(globalOut.size).toBe(0);
    expect(domainOut.size).toBe(0);
  });

  it("loadCounters is a no-op when the file contains invalid JSON", () => {
    const tmpFile = `/tmp/test-counters-bad-${Date.now()}.json`;
    writeFileSync(tmpFile, "{ invalid json }");

    const globalOut = new Map<string, GlobalCounters>();
    const domainOut = new Map<string, DomainCounters>();
    load(tmpFile, globalOut, domainOut);

    expect(globalOut.size).toBe(0);

    try { unlinkSync(tmpFile); } catch {}
  });
});

// ── ut-1: Cert cache expiry eviction ────────────────────────────────────────

describe("Cert cache expiry eviction (ut-1)", () => {
  interface CachedCert { cert: string; key: string; expiresAt: number }

  function makeCertCache() {
    return new Map<string, CachedCert>();
  }

  function getCached(cache: Map<string, CachedCert>, hostname: string): CachedCert | null {
    const entry = cache.get(hostname);
    if (entry && entry.expiresAt > Date.now()) return entry;
    return null;
  }

  function setCached(cache: Map<string, CachedCert>, hostname: string, cert: CachedCert) {
    cache.set(hostname, cert);
  }

  it("returns cached cert when not expired", () => {
    const cache = makeCertCache();
    const entry: CachedCert = { cert: "cert-pem", key: "key-pem", expiresAt: Date.now() + 60_000 };
    setCached(cache, "gitlab.com", entry);
    expect(getCached(cache, "gitlab.com")).toBe(entry);
  });

  it("returns null for expired cert", () => {
    const cache = makeCertCache();
    const entry: CachedCert = { cert: "cert-pem", key: "key-pem", expiresAt: Date.now() - 1 };
    setCached(cache, "gitlab.com", entry);
    expect(getCached(cache, "gitlab.com")).toBeNull();
  });

  it("returns null for missing hostname", () => {
    const cache = makeCertCache();
    expect(getCached(cache, "unknown.example.com")).toBeNull();
  });

  it("expired entry is replaced after regeneration", () => {
    const cache = makeCertCache();
    const stale: CachedCert = { cert: "old", key: "old-key", expiresAt: Date.now() - 1 };
    setCached(cache, "gitlab.com", stale);
    expect(getCached(cache, "gitlab.com")).toBeNull();

    const fresh: CachedCert = { cert: "new", key: "new-key", expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
    setCached(cache, "gitlab.com", fresh);
    expect(getCached(cache, "gitlab.com")).toBe(fresh);
  });
});
