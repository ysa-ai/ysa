import { readFile, stat } from "fs/promises";
import { resolve } from "path";
import { getProvider } from "../providers";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runShell(
  cmd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// Resolve paths relative to this package's container/ dir
const SANDBOX_SCRIPT = resolve(import.meta.dir, "..", "..", "container", "sandbox-run.sh");
export const SECCOMP_PROFILE = resolve(import.meta.dir, "..", "..", "container", "seccomp.json");

export interface SpawnSandboxOpts {
  worktree: string;
  gitDir: string;
  branch: string;
  mode: string;        // "readwrite" or "readonly"
  id: string;          // task ID
  cliArgs: string[];
  env: Record<string, string>;
  logPath?: string;
  cwd?: string;
  networkPolicy?: "none" | "strict" | "custom";
  agentBinary?: string;       // CLI binary name, e.g. "claude" or "vibe"
  agentInitScript?: string;   // shell fragment eval'd in container before agent launch
  agentAuthEnvFlags?: string; // pre-built "-e KEY1 -e KEY2" string for auth env forwarding
  agentImage?: string;        // container image name, e.g. "sandbox-claude" or "sandbox-mistral"
  provider?: string;          // provider id, used for session ID extraction
  extraPodEnv?: string;       // opaque "-e KEY=val -e KEY2=val2" string forwarded verbatim to podman run
}

export function spawnSandbox(opts: SpawnSandboxOpts) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...opts.env };
  if (opts.logPath) env.LOG_FILE = opts.logPath;
  if (opts.networkPolicy) env.NETWORK_POLICY = opts.networkPolicy;
  if (opts.agentBinary) env.AGENT_BINARY = opts.agentBinary;
  if (opts.agentInitScript) env.AGENT_INIT_SCRIPT = opts.agentInitScript;
  if (opts.agentAuthEnvFlags !== undefined) env.AGENT_AUTH_ENV_FLAGS = opts.agentAuthEnvFlags;
  if (opts.agentImage) env.AGENT_IMAGE = opts.agentImage;
  if (opts.extraPodEnv) env.EXTRA_POD_ENV = opts.extraPodEnv;

  return Bun.spawn(
    [
      "bash", SANDBOX_SCRIPT,
      opts.worktree,
      opts.gitDir,
      opts.branch,
      opts.mode,
      opts.id,
      ...opts.cliArgs,
    ],
    {
      cwd: opts.cwd,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}

export async function stopContainer(
  id: string,
  opts?: { logPath?: string; label?: string; provider?: string },
): Promise<string | null> {
  const label = opts?.label ?? "task";
  await runShell(
    `podman stop $(podman ps -q --filter label=${label}=${id}) 2>/dev/null || true`,
  );

  let sessionId: string | null = null;
  if (opts?.logPath && await fileExists(opts.logPath)) {
    const logContent = await readFile(opts.logPath, "utf-8");
    const adapter = getProvider(opts?.provider ?? "claude");
    sessionId = adapter.extractSessionId(logContent);
  }

  return sessionId;
}

export async function teardownContainer(
  id: string,
  opts?: { label?: string },
): Promise<void> {
  const label = opts?.label ?? "task";
  await runShell(
    `podman stop $(podman ps -q --filter label=${label}=${id}) 2>/dev/null || true`,
  );
  await runShell(
    `podman volume rm task-session-${id} node-modules-${id} 2>/dev/null || true`,
  );
}
