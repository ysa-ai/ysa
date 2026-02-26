import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { trpcServer } from "@hono/trpc-server";
import { coreRouter } from "../api";
import { runMigrations } from "../db/migrate";
import { getServerConfig } from "../api/config-store";
import { startResourcePoller } from "../lib/resources";
import { stopProxy } from "../runtime/proxy";
import { join } from "path";

runMigrations();
startResourcePoller();

const { port: PORT } = getServerConfig();

const app = new Hono();

app.use("/trpc/*", cors());
app.use(
  "/trpc/*",
  trpcServer({
    router: coreRouter,
  }),
);

// ─── Prompt store (generic endpoint for container to fetch prompt) ────
const promptStore = new Map<string, string>();

app.post("/api/prompt/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.text();
  promptStore.set(id, body);
  return c.json({ ok: true });
});

app.get("/api/prompt/:id", (c) => {
  const id = c.req.param("id");
  const content = promptStore.get(id);
  if (!content) return c.text("", 404);
  return c.text(content);
});

// Serve built Vite assets
const distDir = join(import.meta.dir, "..", "..", "dist");
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
