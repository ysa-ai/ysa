import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  task_id: text("task_id").notNull().unique(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(), // queued | running | completed | failed | stopped | archived
  branch: text("branch").notNull(),
  worktree: text("worktree").notNull(),
  session_id: text("session_id"),
  error: text("error"),
  failure_reason: text("failure_reason"), // max_turns | infrastructure | null
  network_policy: text("network_policy").notNull().default("none"), // none | strict | custom
  provider: text("provider").notNull().default("claude"),
  model: text("model"),
  allowed_hosts: text("allowed_hosts"), // comma-separated bypass hosts for strict network policy
  log_path: text("log_path"),
  started_at: text("started_at"),
  finished_at: text("finished_at"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const containerPeaks = sqliteTable("container_peaks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  peak_mb: integer("peak_mb").notNull(),
  recorded_at: text("recorded_at").notNull().default(sql`(datetime('now'))`),
});

export const config = sqliteTable("config", {
  id: integer("id").primaryKey().default(1),
  project_root: text("project_root"),
  default_model: text("default_model"),
  default_network_policy: text("default_network_policy").notNull().default("none"),
  preferred_terminal: text("preferred_terminal"),
  port: integer("port"),
  anthropic_api_key: text("anthropic_api_key"),
  mistral_api_key: text("mistral_api_key"),
  auth_token: text("auth_token"),
  max_concurrent_tasks: integer("max_concurrent_tasks").notNull().default(10),
  languages: text("languages").notNull().default("[]"),
});
