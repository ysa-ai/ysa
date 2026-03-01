import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

export type ProviderName = "anthropic" | "mistral";

const _cache = new Map<string, boolean>();

function ysaBaseDir(): string {
  return process.env.YSA_HOME ?? homedir();
}

function keysFilePath(): string {
  return join(ysaBaseDir(), ".ysa", "keys.json");
}

async function readKeysFile(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(keysFilePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeKeysFile(keys: Record<string, string>): Promise<void> {
  const path = keysFilePath();
  const tmp = path + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(keys), { mode: 0o600 });
  await rename(tmp, path);
}

export async function getApiKey(name: ProviderName): Promise<string | null> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", `ysa.apikey.${name}`, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || !stdout.trim()) return null;
    return stdout.trim();
  } else {
    const keys = await readKeysFile();
    return keys[name] ?? null;
  }
}

export async function setApiKey(name: ProviderName, value: string | null): Promise<void> {
  if (process.platform === "darwin") {
    if (value !== null) {
      const proc = Bun.spawn(
        ["security", "add-generic-password", "-U", "-s", `ysa.apikey.${name}`, "-a", "", "-w", value],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
    } else {
      const proc = Bun.spawn(
        ["security", "delete-generic-password", "-s", `ysa.apikey.${name}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited; // ignore non-zero exit
    }
  } else {
    const keys = await readKeysFile();
    if (value !== null) {
      keys[name] = value;
    } else {
      delete keys[name];
    }
    await writeKeysFile(keys);
  }
  _cache.set(name, value !== null);
}

export async function hasApiKey(name: ProviderName): Promise<boolean> {
  if (_cache.has(name)) {
    return _cache.get(name)!;
  }
  const key = await getApiKey(name);
  const result = key !== null;
  _cache.set(name, result);
  return result;
}
