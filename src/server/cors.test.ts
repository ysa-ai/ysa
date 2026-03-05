import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";

const PORT = 4000;

function makeApp() {
  const app = new Hono();
  app.use("/trpc/*", cors({
    origin: [
      `http://localhost:4001`,
      `http://127.0.0.1:4001`,
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
    ],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }));
  app.get("/trpc/test", (c) => c.json({ ok: true }));
  return app;
}

function preflight(app: Hono, origin: string) {
  return app.request("/trpc/test", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization",
    },
  });
}

describe("CORS middleware", () => {
  it("ut-1: localhost:4001 receives matching origin and credentials header", async () => {
    const app = makeApp();
    const res = await preflight(app, "http://localhost:4001");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4001");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("ut-2: 127.0.0.1:4001 receives matching origin and credentials header", async () => {
    const app = makeApp();
    const res = await preflight(app, "http://127.0.0.1:4001");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:4001");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("ut-3: localhost:4000 (production origin) receives matching origin and credentials header", async () => {
    const app = makeApp();
    const res = await preflight(app, "http://localhost:4000");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4000");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("ut-4: untrusted origin does not receive a matching Access-Control-Allow-Origin header", async () => {
    const app = makeApp();
    const res = await preflight(app, "http://evil.example.com");
    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin).not.toBe("http://evil.example.com");
  });
});
