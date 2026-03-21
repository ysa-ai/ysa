import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const YSA_DIR = join(homedir(), ".ysa");
const AUTH_TOKEN_FILE = join(YSA_DIR, "auth-token");

export function getOrCreateAuthToken(): string {
  if (existsSync(AUTH_TOKEN_FILE)) {
    const token = readFileSync(AUTH_TOKEN_FILE, "utf-8").trim();
    if (token) return token;
  }
  const token = crypto.randomUUID();
  mkdirSync(YSA_DIR, { recursive: true });
  writeFileSync(AUTH_TOKEN_FILE, token, "utf-8");
  return token;
}
