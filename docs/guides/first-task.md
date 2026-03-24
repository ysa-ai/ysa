# First Task

Install ysa, configure it for your project, and run your first sandboxed task.

## Prerequisites

- **Podman 5.x+** (rootless) — [install guide](https://podman.io/docs/installation)
- **Bun 1.2+** — [install guide](https://bun.sh/docs/installation)
- A Claude account with API access (for the default Claude provider)

## 1. Install

```bash
npm install -g @ysa-ai/ysa
```

Or with bun:

```bash
bun install -g @ysa-ai/ysa
```

## 2. Run setup

```bash
ysa setup
```

This checks Podman, generates the CA cert at `~/.ysa/proxy-ca/`, builds any missing container images (`sandbox-claude`, `sandbox-mistral`, `sandbox-proxy`), installs OCI network hooks, and runs a smoke test. Fix any reported issues before continuing.

## 3. Configure runtimes (optional)

If your project needs specific runtimes inside the container — see the [full list of supported languages](/guides/runtimes#supported-languages):

```bash
cd /path/to/your/project
ysa runtime detect   # auto-detect from package.json, pyproject.toml, go.mod, etc.
```

Or add manually:

```bash
ysa runtime add node@22
```

This writes `.ysa.toml` — commit it so everyone on your team gets the same sandbox.

## 4. Run your first task

```bash
cd /path/to/your/project
ysa run "add a health check endpoint that returns 200 OK"
```

ysa will:
1. Create a git worktree at `.ysa/worktrees/<task-id>`
2. Spin up a Podman container with the worktree bind-mounted at `/workspace`
3. Run the Claude agent against your prompt
4. Stream output to your terminal
5. Print the worktree path and session ID when done

## 5. Review the result

The worktree at `.ysa/worktrees/<task-id>` is **bind-mounted** into the container as `/workspace`. This means the agent writes directly to your host filesystem — any file it creates or modifies is visible on your machine in real time, with no commit or copy step needed to inspect the result.

The agent commits its changes to the worktree branch by default. To bring those changes into your main branch:

```bash
# Option 1 — merge the branch
git merge task/<task-id-prefix>

# Option 2 — cherry-pick specific commits
git cherry-pick <commit-hash>

# Option 3 — just copy the files you want
cp .ysa/worktrees/<task-id>/src/health.ts src/
```

To iterate before merging:

```bash
ysa refine <task-id-prefix> "also add a /ready endpoint"
```

View the full agent log:

```bash
ysa logs <task-id-prefix>
```

## 6. Clean up

```bash
ysa teardown <task-id-prefix>
```

This removes the container and worktree. The branch is kept — delete it manually once merged.

## Next steps

- [Runtimes guide](/guides/runtimes) — configure languages and apt packages
- [Network policies](/guides/network) — control what the agent can access
- [Review tasks](/guides/review-tasks) — run analysis without letting the agent commit
