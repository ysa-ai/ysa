import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { trpcServer } from "@hono/trpc-server";
import { coreRouter } from "../api";
import { runMigrations } from "../db/migrate";
import { getServerConfig, getOrCreateAuthToken } from "../api/config-store";
import { requireLocalToken } from "./auth";
import { startResourcePoller } from "../lib/resources";
import { stopProxy } from "../runtime/proxy";
import { join } from "path";

runMigrations();
startResourcePoller();

const { port: PORT } = getServerConfig();

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
app.use("/trpc/*", requireLocalToken);
app.use(
  "/trpc/*",
  trpcServer({
    router: coreRouter,
  }),
);

// Prompt store (generic endpoint for container to fetch prompt)
const promptStore = new Map<string, string>();

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

// Unauthenticated token endpoint for dev mode (Vite proxies this)
app.get("/api/token", (c) => {
  return c.text(getOrCreateAuthToken());
});

// Serve built Vite assets - inject token into index.html
const distDir = join(import.meta.dir, "..", "..", "dist");
app.get("/", async (c) => {
  const token = getOrCreateAuthToken();
  const html = await Bun.file(join(distDir, "index.html")).text();
  const injected = html.replace(
    "<head>",
    `<head><script>window.__YSA_TOKEN__="${token}";</script>`,
  );
  return c.html(injected);
});
app.use("/*", serveStatic({ root: distDir }));
app.use("/*", serveStatic({ root: distDir, path: "index.html" }));

export default {
  port: PORT,
  fetch: app.fetch,
};

// Cleanup proxy container on shutdown
const cleanup = () => {
  stopProxy().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

console.log(`\n  ysa running at http://localhost:${PORT}\n`);
