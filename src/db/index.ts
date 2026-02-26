import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb(dbPath?: string) {
  if (!_db) {
    const path = dbPath ?? join(homedir(), ".ysa", "core.db");
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}

export { schema };
