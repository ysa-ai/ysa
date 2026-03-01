import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "./auth";

const MOCK_TOKEN = "test-prompt-token-xyz789";

function makePromptApp() {
  const requireLocalToken = createAuthMiddleware(() => MOCK_TOKEN);
  const promptStore = new Map<string, string>();
  const app = new Hono();

  app.post("/api/prompt/:id", requireLocalToken, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.text();
    promptStore.set(id, body);
    return c.json({ ok: true });
  });

  app.get("/api/prompt/:id", requireLocalToken, (c) => {
    const id = c.req.param("id");
    const content = promptStore.get(id);
    if (!content) return c.text("", 404);
    return c.text(content);
  });

  return { app, promptStore };
}

describe("prompt endpoints", () => {
  describe("GET /api/prompt/:id", () => {
    it("ut-1: returns 401 when no Authorization header is present", async () => {
      const { app, promptStore } = makePromptApp();
      promptStore.set("task-1", "my prompt");
      const res = await app.request("/api/prompt/task-1");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("ut-2: returns the stored prompt body when a valid Authorization: Bearer <token> header is sent", async () => {
      const { app, promptStore } = makePromptApp();
      promptStore.set("task-2", "my stored prompt content");
      const res = await app.request("/api/prompt/task-2", {
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("my stored prompt content");
    });

    it("returns 404 for unknown prompt id with valid token", async () => {
      const { app } = makePromptApp();
      const res = await app.request("/api/prompt/unknown-id", {
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/prompt/:id", () => {
    it("ut-3: returns 401 when no Authorization header is present", async () => {
      const { app } = makePromptApp();
      const res = await app.request("/api/prompt/task-3", {
        method: "POST",
        body: "some prompt text",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("stores the prompt and returns ok when valid token is provided", async () => {
      const { app, promptStore } = makePromptApp();
      const res = await app.request("/api/prompt/task-4", {
        method: "POST",
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
        body: "new prompt text",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(promptStore.get("task-4")).toBe("new prompt text");
    });
  });
});
