import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

const KEYCHAIN_SERVICE = "ysa-keys";
const KEYS_FILE = join(homedir(), ".config", "ysa", "keys.json");

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getApiKey(provider: string): Promise<string | null> {
  if (process.platform === "darwin") return loadFromKeychain(provider);
  return loadFromFile(provider);
}

export async function setApiKey(provider: string, key: string): Promise<void> {
  if (process.platform === "darwin") return saveToKeychain(provider, key);
  return saveToFile(provider, key);
}

export async function deleteApiKey(provider: string): Promise<void> {
  if (process.platform === "darwin") return deleteFromKeychain(provider);
  return deleteFromFile(provider);
}

// ─── macOS Keychain ───────────────────────────────────────────────────────────

async function saveToKeychain(provider: string, key: string): Promise<void> {
  const proc = Bun.spawn(
    ["security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider, "-w", key, "-U"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

async function loadFromKeychain(provider: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider, "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || null;
}

async function deleteFromKeychain(provider: string): Promise<void> {
  const proc = Bun.spawn(
    ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

// ─── Linux: permission-restricted file ───────────────────────────────────────

async function loadFromFile(provider: string): Promise<string | null> {
  try {
    const content = await readFile(KEYS_FILE, "utf-8");
    const all = JSON.parse(content) as Record<string, string>;
    return all[provider] ?? null;
  } catch {
    return null;
  }
}

async function saveToFile(provider: string, key: string): Promise<void> {
  let all: Record<string, string> = {};
  try {
    const content = await readFile(KEYS_FILE, "utf-8");
    all = JSON.parse(content);
  } catch {}
  all[provider] = key;
  await mkdir(dirname(KEYS_FILE), { recursive: true });
  await writeFile(KEYS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

async function deleteFromFile(provider: string): Promise<void> {
  try {
    const content = await readFile(KEYS_FILE, "utf-8");
    const all = JSON.parse(content) as Record<string, string>;
    delete all[provider];
    await writeFile(KEYS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {}
}
