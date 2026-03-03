import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function ysaBaseDir(): string {
  return process.env.YSA_HOME ?? homedir();
}

function auditLogPath(): string {
  return join(ysaBaseDir(), ".ysa", "audit.log");
}

export function writeAuditLog(action: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, ...data }) + "\n";
  const logPath = auditLogPath();
  mkdir(join(ysaBaseDir(), ".ysa"), { recursive: true })
    .then(() => appendFile(logPath, line, { mode: 0o600 }))
    .catch(() => {});
}
