import { stat, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runShell(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

function installsPathForProject(projectRoot: string): string {
  const hash = Bun.hash(projectRoot).toString(16).slice(0, 8);
  return join(homedir(), ".cache", "ysa-agent", "mise-installs", hash);
}

function hashTools(tools: string[]): string {
  return Bun.hash([...tools].sort().join(",")).toString(16);
}

async function getToolsHash(installsPath: string): Promise<string | null> {
  try {
    const content = await readFile(join(installsPath, ".tools-hash"), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

// Ensure mise runtimes are pre-installed for the project.
// Returns the mise-installs host path if tools were found/installed, undefined otherwise.
// Fast path: if the installs dir already has a matching tools hash, returns immediately.
// toolsOverride: explicit list from .ysa.toml — takes precedence over file detection.
export async function ensureMiseRuntimes(
  projectRoot: string,
  image: string = "sandbox-claude",
  onProgress?: (message: string) => void,
  toolsOverride?: string[],
): Promise<string | undefined> {
  let tools: string[];

  if (toolsOverride && toolsOverride.length > 0) {
    tools = toolsOverride;
  } else {
    const hasMiseToml = await fileExists(join(projectRoot, ".mise.toml"));
    const hasToolVersions = await fileExists(join(projectRoot, ".tool-versions"));
    if (!hasMiseToml && !hasToolVersions) return undefined;
    tools = ["__auto__"];
  }

  const installsPath = installsPathForProject(projectRoot);
  const hash = installsPath.split("/").pop() ?? "mise";
  const dataVolume = `mise-data-${hash}`;
  const targetHash = hashTools(tools);

  if (await getToolsHash(installsPath) === targetHash) return installsPath;

  onProgress?.("Installing runtimes via mise...");

  await runShell(`rm -rf "${installsPath}" && mkdir -p "${installsPath}"`);
  await runShell(`podman volume exists ${dataVolume} 2>/dev/null || podman volume create ${dataVolume}`);

  const isAuto = tools[0] === "__auto__";
  const installCmd = isAuto
    ? '"$MISE" install --cd /workspace --yes 2>&1'
    : tools.map((t) => `"$MISE" use --global "${t}" --yes 2>/dev/null || true`).join("\n");

  const script = [
    'MISE=/home/agent/.local/bin/mise',
    '[ -x "$MISE" ] || exit 1',
    installCmd,
    '"$MISE" bin-paths 2>/dev/null | tr \'\\n\' \':\' | sed \'s/:$//\' > /home/agent/.local/share/mise/installs/.bin-paths',
  ].join("\n");

  const runArgs = [
    "podman", "run", "--rm",
    "--userns=keep-id",
    "--network", "slirp4netns",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-e", "HOME=/home/agent",
    "-e", "MISE_DATA_DIR=/home/agent/.local/share/mise",
    "--mount", `type=volume,src=${dataVolume},dst=/home/agent/.local/share/mise`,
    "-v", `${installsPath}:/home/agent/.local/share/mise/installs`,
  ];

  if (isAuto) {
    runArgs.push("-v", `${projectRoot}:/workspace:ro`);
  }

  runArgs.push(image, "-c", script);

  const proc = Bun.spawn(runArgs, { stdout: "pipe", stderr: "pipe" });
  await proc.exited;

  if (proc.exitCode !== 0) return undefined;

  await Bun.write(join(installsPath, ".tools-hash"), targetHash);
  return installsPath;
}
