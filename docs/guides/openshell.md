# ysa vs OpenShell

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) is an open-source sandboxed execution runtime for AI coding agents. It solves a similar problem — running agents safely in isolated containers — but at a different level of the stack.

## Different levels of integration

**OpenShell is generic infrastructure.** It is a platform you deploy: a Docker + K3s cluster, a gateway service, and a policy engine. It gives you deny-by-default network egress, hot-reloadable YAML policies, and support for remote SSH deployment. It is designed to run agents in a variety of contexts — local, remote, multi-tenant — and leaves orchestration, git workflows, and developer tooling entirely to you.

**ysa is a local developer tool.** It is a library you import and a CLI you run. It is opinionated about how agents work against a codebase: one git worktree per task, language runtimes pre-installed via mise, a MITM proxy enforcing network policy, and a `runTask()` call that handles the full lifecycle. No cluster to deploy, no daemon to manage.

Both use hardened containers. The difference is scope and target user.

## Concrete differences

| | **ysa** | **OpenShell** |
|---|---|---|
| **Integration** | Library + CLI | Service you deploy (Docker + K3s) |
| **Container runtime** | Rootless Podman | Docker |
| **Image size** | ~400 MB (one runtime) | 3 GB+ to bootstrap (cluster + gateway + sandbox) |
| **Git isolation** | One worktree per task, built-in | None |
| **Language runtimes** | Auto-detect + mise, `.ysa.toml` | Not included |
| **Network policy** | MITM proxy, per-task scoped rules | Egress engine, hot-reloadable YAML, deny-by-default |
| **Remote deployment** | No | SSH (`--remote user@host`) |
| **Supported agents** | Claude, Mistral | Claude, OpenCode, Codex, Copilot CLI |

## When OpenShell makes more sense

OpenShell is a better fit if you are building **agent infrastructure for a team or platform** — not using agents as a developer yourself.

- **Multi-tenant or remote deployments**: SSH target support and a gateway service designed to serve multiple users or environments.
- **Hot-reloadable policies**: change network rules on a running sandbox without restarting it — useful when operating a shared service.
For a single developer running agents against their own codebase, none of these are relevant — and the operational cost (K3s, Docker, 3 GB+ of images) is high for what you get.

## Why ysa for local development

**Rootless Podman.** The container daemon itself runs as an unprivileged user — no root process on the host, no `docker` group membership required. OpenShell requires Docker.

**Git worktrees.** Every `runTask()` call creates an isolated branch and filesystem snapshot automatically. Agents running in parallel never interfere with each other or your working tree. OpenShell has no equivalent.

**~400 MB vs 3 GB+.** ysa's sandbox image is ~400 MB with one runtime installed. OpenShell requires pulling a K3s cluster image, a gateway image, and a base sandbox image before anything runs.

**No infrastructure.** `npm install -g @ysa-ai/ysa && ysa setup` is the entire install. No cluster bootstrap, no daemon, no Kubernetes.

**Library-first.** ysa is a TypeScript package — embed it in your own tooling, CI pipeline, or platform with `import { runTask }`. OpenShell is a system you talk to via CLI or YAML config.
