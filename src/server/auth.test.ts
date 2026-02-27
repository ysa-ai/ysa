import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "./auth";

const MOCK_TOKEN = "test-secret-token-abc123";

function makeApp() {
  const requireLocalToken = createAuthMiddleware(() => MOCK_TOKEN);
  const app = new Hono();
  app.use("/trpc/*", requireLocalToken);
  app.get("/trpc/test", (c) => c.json({ ok: true }));
  return app;
}

describe("requireLocalToken middleware", () => {
  it("ut-2: returns 401 with { error: 'Unauthorized' } when Authorization header is absent", async () => {
    const app = makeApp();
    const res = await app.request("/trpc/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("ut-3: returns 401 when Authorization header contains an incorrect token", async () => {
    const app = makeApp();
    const res = await app.request("/trpc/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("ut-3b: returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const app = makeApp();
    const res = await app.request("/trpc/test", {
      headers: { Authorization: MOCK_TOKEN },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("ut-4: calls next() and allows the request when correct Authorization Bearer token is present", async () => {
    const app = makeApp();
    const res = await app.request("/trpc/test", {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
