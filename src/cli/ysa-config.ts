import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

export interface YsaConfig {
  sandbox?: {
    runtimes?: string[];  // mise tools, e.g. ["node@22", "python@3.12"]
    packages?: string[];  // apt packages, e.g. ["libpq-dev", "imagemagick"]
  };
}

function parseToml(content: string): YsaConfig {
  const config: YsaConfig = {};
  let section = "";

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    if (section !== "sandbox") continue;

    const kvMatch = line.match(/^(\w+)\s*=\s*\[(.*)]\s*$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const items = [...kvMatch[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!config.sandbox) config.sandbox = {};
    if (key === "runtimes") config.sandbox.runtimes = items;
    if (key === "packages") config.sandbox.packages = items;
  }

  return config;
}

function serializeToml(config: YsaConfig): string {
  const lines: string[] = ["[sandbox]"];
  const arr = (items: string[]) => `[${items.map((i) => `"${i}"`).join(", ")}]`;
  if (config.sandbox?.runtimes?.length) lines.push(`runtimes = ${arr(config.sandbox.runtimes)}`);
  if (config.sandbox?.packages?.length) lines.push(`packages = ${arr(config.sandbox.packages)}`);
  return lines.join("\n") + "\n";
}

export async function readYsaConfig(projectRoot: string): Promise<YsaConfig> {
  const path = join(projectRoot, ".ysa.toml");
  if (!existsSync(path)) return {};
  return parseToml(await readFile(path, "utf-8"));
}

export async function writeYsaConfig(projectRoot: string, config: YsaConfig): Promise<void> {
  await writeFile(join(projectRoot, ".ysa.toml"), serializeToml(config), "utf-8");
}
