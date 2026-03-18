# Your Secure Agent

[![npm](https://img.shields.io/npm/v/@ysa-ai/ysa)](https://www.npmjs.com/package/@ysa-ai/ysa)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://open.ysa.run)

> **Early development** — this repo is under active development. Expect breaking changes between releases.

**ysa is a secure container runtime for AI coding agents — a CLI and SDK, nothing else.**

Every agent runs in an isolated, rootless Podman container with a hardened sandbox, its own git worktree, and optional network policy enforcement. No cloud, no telemetry, no data leaving your machine.

```bash
ysa setup          # one-time setup on a fresh machine
ysa run "prompt"   # from any git repo, zero config
```

If you want a fully-featured orchestration layer on top of ysa — GitLab/GitHub integration, multi-phase workflows, team management — ysa platform (coming soon at ysa.run) is built exactly this way.

<p align="center"><img src="./docs/architecture-overview.svg" width="600" /></p>

> [Detailed architecture diagram](./docs/architecture.svg)

---

## Why ysa?

| Goal | What ysa does |
|---|---|
| **Security** | Every agent runs in a locked-down container: no root, read-only filesystem, syscall whitelist, capability-stripped |
| **Sovereignty** | Runs entirely on your machine. No cloud, no telemetry, no data leaving your network |
| **Composability** | Use `runTask()` as a primitive to build any orchestration layer on top |

---

## Features

- **Hardened sandbox** — rootless Podman with defense-in-depth (see [Container security](#container-security))
- **Network policy** — optional outbound traffic control with a local proxy and firewall enforcement
- **Multi-language** — one container image, any runtime: Node.js, Python, Go, Rust, Ruby, PHP, Java, .NET, Elixir, C/C++ (via [mise](https://mise.jdx.dev) + apt)
- **Multi-provider** — Claude Code and Mistral out of the box, extensible via `registerProvider()`
- **SDK** — `import { runTask } from "@ysa-ai/ysa/runtime"` — build your own orchestration layer
- **Session resume** — continue or refine a stopped/completed agent session
- **Sandbox shell** — open an interactive session inside the secured container for manual intervention

---

## Roadmap

The current repo still ships a local web dashboard alongside the CLI. That's going away. The plan:

**Phase 1 — CLI improvements**
- `ysa setup` — single turnkey command on a fresh machine (Podman check, image build, CA cert, OCI hooks, proxy smoke test)
- Git root auto-detection — `ysa run` walks up from CWD like `git` does, no config required
- Real-time streaming output during `ysa run`
- `ysa refine <id> "prompt"` — iterate on a completed task in the same session and worktree
- Auto mise pre-install when `.mise.toml` is detected

**Phase 2 — Clean public SDK API**
- Expose a stable, minimal `RunConfig` interface — no internal provider fields leaking to callers
- Proxy auto-start inside `runTask()` when `networkPolicy: "strict"` — works without running the server

**Phase 3 — Orchestration guide**
- One doc, code-first, inspired by OpenAI Symphony: concept → code → done
- Covers `runTask()`, providers, multi-language, result reading, basic orchestration loops
- Written after the API is stable

**After that:** the dashboard is removed from this repo. ysa becomes a pure runtime — CLI + SDK, Apache 2.0, no paid tier. ysa platform (coming soon at ysa.run) is the hosted orchestration layer built on top of it.

> The license change will follow once the dashboard is stripped — the repo will move from its current license to Apache 2.0 fully, matching the landing page. The Apache 2.0 license is already reflected on [open.ysa.run](https://open.ysa.run) ahead of that change.

---

## Requirements

- [Bun](https://bun.sh) 1.2+
- [Podman](https://podman.io) (rootless mode)
- macOS or Linux
- Windows support coming soon

---

## Installation

```bash
git clone https://github.com/ysa-ai/ysa
cd ysa
bun install

# Build the container images (one-time, ~2–3 min)
bun run build:images
```

## Quick start

```bash
# Start the server (opens the web UI at http://localhost:4000)
ysa

# Or run a task directly from the CLI
ysa run "summarize this codebase" --branch main
```

On first launch, the web UI will ask you to set a project root — the directory where your code lives. This is stored locally and never leaves your machine.

## CLI

```bash
ysa                        # Start the web server + UI
ysa run "prompt" [opts]    # Run a task
ysa list                   # List tasks
ysa logs <task-id>         # Stream logs for a task
ysa stop <task-id>         # Stop a running task
ysa teardown               # Remove all worktrees and containers
```

---

## Network policy

Two modes:

- **Unrestricted** — full internet access inside the container
- **Restricted** — all traffic routed through a local MITM proxy. GET-only, no request body, rate limits, outbound byte budget. Enforced at both the proxy and firewall level inside the container network namespace.

---

## Container security

Every container runs directly on the host kernel via rootless Podman — no virtual machine, no hypervisor. The security constraints are enforced at the kernel level:

- `--cap-drop ALL` — strips all Linux process capabilities (no `chown`, no `setuid`, no `net_admin`, no elevated access of any kind)
- `--read-only` — immutable root filesystem; the agent cannot modify system files
- `--security-opt no-new-privileges` — prevents any process inside from gaining elevated privileges
- `--security-opt seccomp=...` — syscall whitelist (~190 allowed out of ~400+); blocks `clone3`, memfd tricks, and other escalation paths
- `--tmpfs /tmp` — writable scratch space is in-memory only
- `--memory 4g --cpus 2 --pids-limit 512` — hard resource limits per container
- Rootless Podman — the container daemon itself runs as an unprivileged user; no process has root on the host at any point

The git `safe-wrapper` shadows `/usr/bin/git` inside the container and strips 38+ dangerous config keys (hooks, filters, SSH command, proxy, credentials). A pre-push guard blocks pushes to any branch except the task's own branch.

### Security test suite

The sandbox is validated by two automated test suites — run them to verify the hardening on your own machine:

```bash
# Run the full security suite (container sandbox + network proxy)
bash container/tests/security-test.sh

# Container sandbox only (no proxy required)
bash container/tests/security-test.sh --skip-network
```

- **`attack-test.sh`** — 155 tests across 38 attack categories: privilege escalation, filesystem escapes, git hook injection, credential theft, signal abuse, and more. Runs inside the container.
- **`network-proxy-test.sh`** — 60 tests for the MITM proxy and firewall enforcement: exfiltration attempts, method bypasses, rule verification.

---

## Language support

ysa uses [mise](https://mise.jdx.dev) as a universal toolchain manager — one container image, any language runtime. Select languages in Settings and ysa provisions the runtimes into a shared cache volume at config time, so containers get the right toolchain without needing network access at task runtime.

| Language | Runtime |
|---|---|
| Node.js / Bun | mise (`node@22`) |
| Python | mise (`python@3.13`) |
| Go | mise (`go@1`) |
| Rust | mise (`rust@1`) |
| .NET | mise (`dotnet@8`) |
| Ruby | mise (`ruby@3.3`) |
| Java (Maven) | mise (`java@21` + `maven@3`) |
| Java (Gradle) | mise (`java@21` + `gradle@8`) |
| Elixir | mise (`elixir@1.18-otp-26`) + apt (`erlang`) |
| PHP | apt (`php-cli`) |
| C / C++ | apt (`g++`) |

---

## Configuration

All configuration is stored in `~/.ysa/core.db` (SQLite). No environment files needed.

Settings managed through the web UI:
- **Project root** — directory where worktrees are created
- **Default provider / model** — pre-fill provider and model selection
- **Default network policy** — Unrestricted or Restricted
- **Languages** — select runtimes to provision into the shared mise cache
- **Preferred terminal** — for the Sandbox Shell feature

---

## Contributing

PRs welcome. See [CLAUDE.md](CLAUDE.md) for code conventions.

---

## License

[Elastic License 2.0](LICENSE) — free to use internally and modify, including within commercial companies. You may not offer ysa as a hosted or managed service to third parties.

### Container runtime

The container security layer — `container/seccomp.json`, `container/git-safe-wrapper.sh`, `container/sandbox-run.sh`, `container/network-proxy.ts`, and related scripts — is intentionally transparent. Read them, audit them, run the test suites against your own setup. Security that can't be verified shouldn't be trusted.

The plan is to extract this runtime into its own standalone repository under a permissive license (MIT or Apache 2.0), so anyone can build their own orchestration layer on top of it freely. If you're interested in doing that before then, the container artifacts are the right starting point.

If you find a gap or want to contribute a hardening improvement, PRs are welcome.
