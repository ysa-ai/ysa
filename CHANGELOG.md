# Changelog

All notable changes are documented here. Breaking changes are marked with ⚠️.

## [0.5.0] - 2026-05-23

### ⚠️ Breaking changes

#### 1. Rebuild sandbox images
```bash
bun run build:images
```
The Containerfile changed significantly. Old `sandbox-claude` / `sandbox-mistral` images are incompatible with the new container scripts and will produce incorrect behavior (wrong HOME, broken mise mounts). Always rebuild after pulling this version.

#### 2. Rename `miseVolume` → `miseInstallsPath` in your code
If you call `runTask()` or `spawnSandbox()` directly:
```ts
// Before
await runTask({ ..., miseVolume: "mise-installs-abc123" });

// After
await runTask({ ..., miseInstallsPath: "/Users/you/.cache/ysa-agent/mise-installs/abc123" });
```
The value is now a host filesystem path (returned by `ensureMiseRuntimes()`), not a Podman volume name. Existing `mise-installs-*` Podman volumes are no longer used and can be removed with `podman volume ls | grep mise-installs | awk '{print $2}' | xargs podman volume rm`.

#### 3. Rename `MISE_VOLUME` → `MISE_INSTALL_PATH` in shell scripts
If any of your scripts set `MISE_VOLUME` before invoking `sandbox-run.sh`, rename it to `MISE_INSTALL_PATH`. The value should be the host path to the mise installs directory, not a volume name.

#### 4. Update in-container paths from `/repo.git` to `/tmp/repo.git`
If you have custom hooks or scripts that run **inside** the sandbox and reference `/repo.git`, change them to `/tmp/repo.git`. This affects the `PreToolUse` / `PostToolUse` hooks and any init scripts that interact with git internals.

---

### Added

- **DeepSeek provider** — use `--provider deepseek` (CLI) or `provider: "deepseek"` (API). Routes Claude Code's protocol through `api.deepseek.com/anthropic` — no custom agent binary needed. Default model: `deepseek-v4-pro`, sub-agents: `deepseek-v4-flash`. Requires an API key: `ysa key set deepseek`.
- **`ysa key` command** — manage provider API keys from the CLI:
  ```bash
  ysa key set deepseek      # prompted securely, no terminal echo
  ysa key check deepseek    # verify a key is stored
  ysa key delete deepseek   # remove a stored key
  ```
- **`--provider` CLI flag** — `ysa run "..." --provider claude|deepseek|mistral`. Previously the CLI was hardcoded to Claude.
- **`.ysa.toml`: `global_packages`** — install packages globally into the project image layer, beyond system packages. Prefix with the package manager:
  ```toml
  [sandbox]
  global_packages = ["pip:playwright", "npm:@playwright/mcp@latest", "bun:zx"]
  ```
  Supported managers: `pip`, `npm`, `gem`, `cargo`, `go`, `bun`.
- **`.ysa.toml`: `init_commands`** — run commands inside the container before the agent starts:
  ```toml
  [sandbox]
  init_commands = ["redis-server --daemonize yes", "pg_ctlcluster 15 main start"]
  ```
- **`RunConfig.bypassHosts`** — open direct TCP access to hosts that don't speak HTTP/HTTPS (bypasses the proxy entirely). Useful for MongoDB, Redis, custom TCP services:
  ```ts
  await runTask({
    networkPolicy: "strict",
    bypassHosts: ["cluster.mongodb.net", "redis.internal:6380"],
  });
  ```
  Entries can be `host` (all ports) or `host:port`. DNS + MongoDB SRV chains are resolved at container start inside the OCI hook.
- **Configurable container resources** — override the sandbox defaults per task:
  ```ts
  await runTask({
    containerMemory: "8g",   // default: 4g
    containerCpus: 4,         // default: 2
    containerPidsLimit: 1024, // default: 512
  });
  ```

### Fixed

- **DNS in strict network mode** — the OCI network hook now uses the `10.0.2.0/24` subnet for DNS `ACCEPT` rules instead of deriving `gateway+1`. The gateway IP isn't in the routing table yet when `createRuntime` hooks fire, so the old approach was unreliable and caused DNS failures.
- **`HOME=/home/agent`** — set explicitly in the container `ENV` and in `sandbox-run.sh`. Also removes `passwd` entries whose home is `/` so tools that call `getpwuid_r` don't compute read-only paths like `/.turbo/cache` or `/.npm`.
- **mise runtimes on macOS** — switched from Podman named volumes to host bind-mounts (`~/.cache/ysa-agent/mise-installs/<hash>/`). Podman volume mountpoints live inside the VM on macOS, making the installed binaries inaccessible from host path logic. Host dirs solve this.
