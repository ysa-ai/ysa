import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Use a real temp directory. keystore.ts reads process.env.YSA_HOME as base path.
const TEST_BASE = join(tmpdir(), `ysa-keystore-test-${process.pid}`);
const KEYS_FILE = join(TEST_BASE, ".ysa", "keys.json");

// Set before the module import so the path is used from the start
process.env.YSA_HOME = TEST_BASE;

const originalYsaHome = process.env.YSA_HOME;

beforeAll(async () => {
  await mkdir(join(TEST_BASE, ".ysa"), { recursive: true });
});

afterAll(async () => {
  delete process.env.YSA_HOME;
  await rm(TEST_BASE, { recursive: true, force: true });
});

beforeEach(async () => {
  // Remove keys file before each test to start fresh
  try { await rm(KEYS_FILE, { force: true }); } catch {}
  try { await rm(KEYS_FILE + ".tmp", { force: true }); } catch {}
});

// Import after YSA_HOME is set — ysaBaseDir() reads it at call time
const { getApiKey, setApiKey, hasApiKey } = await import("./keystore");

describe("keystore — Linux file path", () => {
  it("ut-1: setApiKey stores value; getApiKey returns it; hasApiKey returns true from cache", async () => {
    await setApiKey("anthropic", "sk-test");

    const retrieved = await getApiKey("anthropic");
    expect(retrieved).toBe("sk-test");

    const has = await hasApiKey("anthropic");
    expect(has).toBe(true);

    // Verify the file was actually written
    const contents = JSON.parse(await readFile(KEYS_FILE, "utf-8"));
    expect(contents.anthropic).toBe("sk-test");
  });

  it("ut-2: setApiKey with null clears value; getApiKey returns null; hasApiKey returns false from cache", async () => {
    await setApiKey("anthropic", "sk-to-delete");
    expect(await getApiKey("anthropic")).toBe("sk-to-delete");

    await setApiKey("anthropic", null);

    const retrieved = await getApiKey("anthropic");
    expect(retrieved).toBeNull();

    const has = await hasApiKey("anthropic");
    expect(has).toBe(false);
  });

  it("ut-1 mistral: setApiKey stores mistral key; getApiKey retrieves it; hasApiKey returns true", async () => {
    await setApiKey("mistral", "mist-key-abc");

    const retrieved = await getApiKey("mistral");
    expect(retrieved).toBe("mist-key-abc");

    expect(await hasApiKey("mistral")).toBe(true);
  });

  it("multiple keys coexist in the same file", async () => {
    await setApiKey("anthropic", "sk-ant-multi");
    await setApiKey("mistral", "mist-multi");

    expect(await getApiKey("anthropic")).toBe("sk-ant-multi");
    expect(await getApiKey("mistral")).toBe("mist-multi");
  });
});
