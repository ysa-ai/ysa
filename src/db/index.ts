import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema });
}

export function getDb(dbPath?: string) {
  if (dbPath) {
    // Explicit path always wins (e.g. migrations)
    return openDb(dbPath);
  }
  if (!_db) throw new Error("Database not initialized. Set a project root first.");
  return _db;
}

export function initDb(projectRoot: string) {
  const path = join(projectRoot, ".ysa", "core.db");
  _db = openDb(path);
  return _db;
}

export function isDbInitialized() {
  return _db !== null;
}

export { schema };
