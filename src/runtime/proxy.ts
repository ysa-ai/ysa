import { resolve } from "path";

const PROXY_CONTAINER_NAME = "ysa-proxy";
const PROXY_PORT = 3128;
const IMAGE = "sandbox-proxy";
const SECCOMP_PROFILE = resolve(import.meta.dir, "..", "..", "container", "seccomp.json");

export interface ScopedAllowRule {
  host: string;       // e.g. "api.example.com"
  pathPrefix: string; // e.g. "/v1/projects/my-project/"
}

const DEFAULT_BYPASS_HOSTS = ["api.anthropic.com", "statsig.anthropic.com"];

async function runShell(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function getContainerState(): Promise<{ rules: ScopedAllowRule[]; bypassHosts: string[] }> {
  const { ok, stdout } = await runShell(
    `podman inspect ${PROXY_CONTAINER_NAME} --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null`,
  );
  if (!ok || !stdout) return { rules: [], bypassHosts: [...DEFAULT_BYPASS_HOSTS] };

  let rules: ScopedAllowRule[] = [];
  let bypassHosts: string[] = [...DEFAULT_BYPASS_HOSTS];

  for (const line of stdout.split("\n")) {
    if (line.startsWith("PROXY_POLICY=")) {
      try {
        const parsed = JSON.parse(line.slice("PROXY_POLICY=".length));
        rules = parsed.scopedAllowRules ?? [];
      } catch {}
    }
    if (line.startsWith("PROXY_BYPASS_HOSTS=")) {
      bypassHosts = line.slice("PROXY_BYPASS_HOSTS=".length).split(",").filter(Boolean);
    }
  }

  return { rules, bypassHosts };
}

export async function isProxyRunning(): Promise<boolean> {
  const { ok, stdout } = await runShell(
    `podman ps --filter name=${PROXY_CONTAINER_NAME} --format '{{.Names}}' 2>/dev/null`,
  );
  return ok && stdout.includes(PROXY_CONTAINER_NAME);
}

export async function startProxy(scopedRules?: ScopedAllowRule[], bypassHosts?: string[]): Promise<void> {
  if (await isProxyRunning()) return;

  // Ensure per-task log directory exists on the host
  await runShell(`mkdir -p $HOME/.ysa/proxy-logs && chmod 0700 $HOME/.ysa/proxy-logs`);

  // Clean up any stopped container with the same name or any container holding our port
  await runShell(`podman rm -f ${PROXY_CONTAINER_NAME} 2>/dev/null || true`);
  const { stdout: portUsers } = await runShell(
    `podman ps --format '{{.Names}}' --filter publish=${PROXY_PORT} 2>/dev/null`,
  );
  for (const name of portUsers.split("\n").filter(Boolean)) {
    await runShell(`podman stop ${name} 2>/dev/null || true`);
    await runShell(`podman rm -f ${name} 2>/dev/null || true`);
  }

  const rules = scopedRules ?? [];
  const hosts = bypassHosts ?? DEFAULT_BYPASS_HOSTS;
  const bypassHostsEnv = `-e PROXY_BYPASS_HOSTS=${hosts.join(",")}`;

  let policyEnv = bypassHostsEnv;
  if (rules.length > 0) {
    const policy = { scopedAllowRules: rules };
    policyEnv += ` -e PROXY_POLICY=${JSON.stringify(JSON.stringify(policy))}`;
  }

  const { ok, stderr } = await runShell(
    `podman run -d \
      --name ${PROXY_CONTAINER_NAME} \
      --user 0:0 \
      --network slirp4netns \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --security-opt seccomp="${SECCOMP_PROFILE}" \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,size=64m \
      --memory 512m \
      --pids-limit 128 \
      --cpus 1 \
      -p ${PROXY_PORT}:${PROXY_PORT} \
      -v $HOME/.ysa/proxy-logs/:/proxy-logs/:rw \
      ${policyEnv} \
      ${IMAGE}`,
  );

  if (!ok) {
    throw new Error(`Failed to start proxy container: ${stderr}`);
  }
}

export async function stopProxy(): Promise<void> {
  await runShell(`podman stop ${PROXY_CONTAINER_NAME} 2>/dev/null || true`);
  await runShell(`podman rm -f ${PROXY_CONTAINER_NAME} 2>/dev/null || true`);
}

export async function ensureProxy(scopedRules?: ScopedAllowRule[], bypassHosts?: string[], serverPort?: number): Promise<void> {
  const needed = scopedRules ?? [];
  const hosts = bypassHosts ?? DEFAULT_BYPASS_HOSTS;
  const allHosts = serverPort ? [...hosts, `host.containers.internal:${serverPort}`] : hosts;
  const running = await isProxyRunning();

  if (running) {
    const { rules: containerRules, bypassHosts: containerHosts } = await getContainerState();

    const missingRules = needed.filter(
      (n) => !containerRules.some((c) => c.host === n.host && c.pathPrefix === n.pathPrefix),
    );
    const missingHosts = allHosts.filter((h) => !containerHosts.includes(h));
    if (missingRules.length === 0 && missingHosts.length === 0) return;

    await stopProxy();
    const mergedRules = [...containerRules, ...missingRules];
    const mergedHosts = [...new Set([...containerHosts, ...missingHosts])];
    await startProxy(mergedRules, mergedHosts);
  } else {
    await startProxy(needed, allHosts);
  }
}
