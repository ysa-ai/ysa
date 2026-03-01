import { describe, it, expect, mock, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Use a real temp directory for the keystore (avoids mocking ./keystore which bleeds across files)
const TEST_BASE = join(tmpdir(), `ysa-migrate-test-${process.pid}`);
process.env.YSA_HOME = TEST_BASE;

// Track DB state
let mockConfigRow: Record<string, any> | undefined = undefined;

// Mock ../db only (not ./keystore — real keystore is used via YSA_HOME)
mock.module("../db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => mockConfigRow,
        }),
      }),
    }),
    update: () => ({
      set: (data: Record<string, any>) => ({
        where: () => ({
          run: () => {
            mockConfigRow = { ...mockConfigRow, ...data };
          },
        }),
      }),
    }),
    insert: () => ({
      values: (data: Record<string, any>) => ({
        run: () => {
          mockConfigRow = data;
        },
      }),
    }),
  }),
  schema: {
    config: {},
  },
}));

beforeAll(async () => {
  await mkdir(join(TEST_BASE, ".ysa"), { recursive: true });
});

afterAll(async () => {
  delete process.env.YSA_HOME;
  await rm(TEST_BASE, { recursive: true, force: true });
});

const { migrateApiKeysFromDb } = await import("./config-store");
const { getApiKey } = await import("./keystore");

describe("migrateApiKeysFromDb", () => {
  beforeEach(async () => {
    mockConfigRow = undefined;
    // Clear any stored keys between tests
    const keysFile = join(TEST_BASE, ".ysa", "keys.json");
    try { await rm(keysFile, { force: true }); } catch {}
  });

  it("ut-3: migrates anthropic_api_key from DB to keystore and nulls the column", async () => {
    mockConfigRow = {
      id: 1,
      project_root: "/test",
      default_model: null,
      default_network_policy: "none",
      preferred_terminal: null,
      port: null,
      anthropic_api_key: "sk-old",
      mistral_api_key: null,
      auth_token: null,
    };

    await migrateApiKeysFromDb();

    // Key should now be in the keystore
    const storedKey = await getApiKey("anthropic");
    expect(storedKey).toBe("sk-old");

    // The DB column should now be null
    expect(mockConfigRow?.anthropic_api_key).toBeNull();
  });

  it("ut-3 idempotent: second call is a no-op when columns are already null", async () => {
    mockConfigRow = {
      id: 1,
      project_root: "/test",
      default_model: null,
      default_network_policy: "none",
      preferred_terminal: null,
      port: null,
      anthropic_api_key: null,
      mistral_api_key: null,
      auth_token: null,
    };

    await migrateApiKeysFromDb();

    // No key should be set in the keystore
    const storedKey = await getApiKey("anthropic");
    expect(storedKey).toBeNull();
  });

  it("ut-3 mistral: migrates mistral_api_key from DB to keystore", async () => {
    mockConfigRow = {
      id: 1,
      project_root: "/test",
      default_model: null,
      default_network_policy: "none",
      preferred_terminal: null,
      port: null,
      anthropic_api_key: null,
      mistral_api_key: "mist-old-key",
      auth_token: null,
    };

    await migrateApiKeysFromDb();

    const storedKey = await getApiKey("mistral");
    expect(storedKey).toBe("mist-old-key");
    expect(mockConfigRow?.mistral_api_key).toBeNull();
  });
});
