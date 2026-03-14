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
const CONTAINER_DIR = resolve(import.meta.dir, "..", "..", "container");

// Rebuild the sandbox-claude image with optional apk packages (e.g. ["php", "ruby"]).
// Generates a fresh CA cert, builds with --build-arg EXTRA_PACKAGES, then cleans up.
// Heavy layers are cached by Podman — only the apk step reruns, so this is fast.
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n|\r/);
    buf = lines.pop() ?? "";
    for (const line of lines) { if (line.trim()) onLine(line); }
  }
  if (buf.trim()) onLine(buf);
}

export async function rebuildSandboxImage(
  apkPackages: string[],
  image: string = "sandbox-claude",
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const caScript = resolve(CONTAINER_DIR, "generate-ca.sh");
  const caGen = await runShell(`bash "${caScript}" "${CONTAINER_DIR}"`);
  if (!caGen.ok) return { ok: false, error: `CA generation failed: ${caGen.stderr}` };

  const extraPackages = apkPackages.join(" ");
  const proc = Bun.spawn([
    "podman", "build", "-t", image,
    "--build-arg", `EXTRA_PACKAGES=${extraPackages}`,
    "-f", `${CONTAINER_DIR}/Containerfile`,
    `${CONTAINER_DIR}/`,
  ], { stdout: "pipe", stderr: "pipe" });

  const errLines: string[] = [];
  await Promise.all([
    streamLines(proc.stdout, (line) => { onLog?.(line); }),
    streamLines(proc.stderr, (line) => { onLog?.(line); errLines.push(line); }),
    proc.exited,
  ]);

  await runShell(`rm -f "${CONTAINER_DIR}/ca.pem" "${CONTAINER_DIR}/ca-key.pem"`);

  const ok = proc.exitCode === 0;
  return { ok, error: ok ? undefined : errLines.join("\n").trim() };
}

// Install language runtimes into a named mise-installs volume via a short-lived
// container. Runs WITHOUT --tmpfs /home/agent so the image's mise binary is
// accessible from the image layer. Writes resolved bin paths to .bin-paths
// inside the volume so task containers can activate tools without touching mise.
export async function installRuntimes(
  tools: string[],
  installsVolume: string,
  image: string = "sandbox-claude",
  extraEnv: Record<string, string> = {},
  runtimeEnv: Record<string, string> = {},
  copyDirs: string[] = [],
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (tools.length === 0) return { ok: true };

  const dataVolume = installsVolume.replace(/^mise-installs/, "mise-data");

  await runShell(`podman volume exists ${installsVolume} 2>/dev/null || podman volume create ${installsVolume}`);
  await runShell(`podman volume exists ${dataVolume} 2>/dev/null || podman volume create ${dataVolume}`);

  const toolEnvLines = Object.entries(runtimeEnv).map(([k, v]) => `export ${k}=${v}`);
  const script = [
    'MISE=/home/agent/.local/bin/mise',
    '[ -x "$MISE" ] || exit 1',
    'for _tool in $MISE_TOOLS; do "$MISE" use --global "${_tool}" --yes 2>/dev/null || true; done',
    ...copyDirs.map(d =>
      `[ -d "/home/agent/.local/share/mise/${d}" ] && cp -r "/home/agent/.local/share/mise/${d}" "/home/agent/.local/share/mise/installs/${d}" || true`
    ),
    '"$MISE" bin-paths 2>/dev/null | tr \'\\n\' \':\' | sed \'s/:$//\' > /home/agent/.local/share/mise/installs/.bin-paths',
    ...copyDirs.map(d =>
      `sed -i 's|/home/agent/.local/share/mise/${d}|/home/agent/.local/share/mise/installs/${d}|g' /home/agent/.local/share/mise/installs/.bin-paths 2>/dev/null || true`
    ),
    toolEnvLines.length > 0
      ? `printf '${toolEnvLines.join('\\n')}\\n' > /home/agent/.local/share/mise/installs/.tool-env`
      : 'rm -f /home/agent/.local/share/mise/installs/.tool-env',
  ].join('\n');

  const proc = Bun.spawn([
    "podman", "run", "--rm",
    "--userns=keep-id",
    "--network", "slirp4netns",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-e", "MISE_DATA_DIR=/home/agent/.local/share/mise",
    "-e", `MISE_TOOLS=${tools.join(" ")}`,
    ...Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--mount", `type=volume,src=${dataVolume},dst=/home/agent/.local/share/mise`,
    "--mount", `type=volume,src=${installsVolume},dst=/home/agent/.local/share/mise/installs`,
    image,
    "-c", script,
  ], { stdout: "pipe", stderr: "pipe" });

  const errLines: string[] = [];
  await Promise.all([
    streamLines(proc.stdout, (line) => { onLog?.(line); }),
    streamLines(proc.stderr, (line) => { onLog?.(line); errLines.push(line); }),
    proc.exited,
  ]);

  const ok = proc.exitCode === 0;
  return { ok, error: ok ? undefined : errLines.join("\n").trim() };
}

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
  shadowDirs?: string[];      // forwarded as SHADOW_DIRS env var to sandbox-run.sh
  miseVolume?: string;        // name of the pre-populated mise-installs volume to mount
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
  if (opts.shadowDirs && opts.shadowDirs.length > 0) env.SHADOW_DIRS = opts.shadowDirs.join(" ");
  if (opts.miseVolume) env.MISE_VOLUME = opts.miseVolume;

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
    `podman volume ls --format '{{.Name}}' | grep -- '-${id}$' | xargs podman volume rm 2>/dev/null || true`,
  );
}
