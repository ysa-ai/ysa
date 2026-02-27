import { describe, it, expect, mock, beforeEach } from "bun:test";

// State for mock DB — simulates the config table row
let mockConfigRow: Record<string, any> | undefined = undefined;

// Mock the db module BEFORE importing config-store.
// auth.test.ts no longer mocks config-store, so this file controls the full stack.
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

const { getOrCreateAuthToken } = await import("./config-store");

describe("getOrCreateAuthToken", () => {
  beforeEach(() => {
    mockConfigRow = undefined;
  });

  it("ut-1: generates a token on first call, persists it, and returns the same token on all subsequent calls", () => {
    // First call — no token stored yet
    const token1 = getOrCreateAuthToken();
    expect(typeof token1).toBe("string");
    expect(token1.length).toBeGreaterThan(0);

    // Token must have been persisted after first call
    expect(mockConfigRow?.auth_token).toBe(token1);

    // Second call — should return the same token without re-generating
    const token2 = getOrCreateAuthToken();
    expect(token2).toBe(token1);

    // Third call — still the same token
    const token3 = getOrCreateAuthToken();
    expect(token3).toBe(token1);
  });
});
