import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { join } from "path";
import { getApiKey, setApiKey } from "./keystore";

export type AppConfig = {
  project_root: string | null;
  default_model: string | null;
  default_network_policy: string;
  preferred_terminal: string | null;
  port: number | null;
  anthropic_api_key: string | null;
  mistral_api_key: string | null;
  auth_token: string | null;
  has_anthropic_key?: boolean;
  has_mistral_key?: boolean;
};

export function getConfig(): AppConfig {
  const db = getDb();
  const row = db.select().from(schema.config).where(eq(schema.config.id, 1)).get();
  return row ?? { project_root: null, default_model: null, default_network_policy: "none", preferred_terminal: null, port: null, anthropic_api_key: null, mistral_api_key: null, auth_token: null };
}

export function setConfig(updates: Partial<AppConfig>) {
  const db = getDb();
  const existing = db.select().from(schema.config).where(eq(schema.config.id, 1)).get();
  if (existing) {
    db.update(schema.config).set(updates).where(eq(schema.config.id, 1)).run();
  } else {
    db.insert(schema.config).values({ id: 1, ...updates }).run();
  }
}

export function getOrCreateAuthToken(): string {
  const config = getConfig();
  if (config.auth_token) {
    return config.auth_token;
  }
  const token = crypto.randomUUID();
  setConfig({ auth_token: token });
  return token;
}

export async function migrateApiKeysFromDb(): Promise<void> {
  const config = getConfig();
  if (config.anthropic_api_key) {
    await setApiKey("anthropic", config.anthropic_api_key);
    setConfig({ anthropic_api_key: null });
  }
  if (config.mistral_api_key) {
    await setApiKey("mistral", config.mistral_api_key);
    setConfig({ mistral_api_key: null });
  }
}

export function getServerConfig() {
  const c = getConfig();
  const projectRoot = c.project_root ?? "";
  const worktreePrefix = projectRoot ? join(projectRoot, ".ysa", "worktrees") + "/" : "";
  const port = c.port ?? 4000;
  return { projectRoot, worktreePrefix, port };
}
