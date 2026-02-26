import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./index";
import { resolve } from "path";

export function runMigrations(dbPath?: string) {
  const db = getDb(dbPath);
  migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "migrations"),
  });
}
