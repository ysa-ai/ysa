# ysa

## Project overview

Standalone tool that runs AI coding agents in parallel inside hardened Podman containers with git worktree isolation. Web UI + CLI. No cloud, no accounts — runs entirely on your machine.

## Quick reference

| Action | Command |
|---|---|
| Dev server | `bun run dev` (Vite :4001 + Hono :4000) |
| Build | `bun run build` |
| Typecheck | `bun run typecheck` |
| Test | `bun run test` |

## Stack

- **Runtime**: Bun 1.2+
- **Server**: Hono + tRPC 11
- **Frontend**: React 19 + React Query + Tailwind CSS v4
- **Database**: SQLite (Bun native) + Drizzle ORM
- **Containers**: Rootless Podman
- **Validation**: Zod 4

## Structure

```
src/
  api/           — tRPC routers (tasks, task-actions, system, config)
  cli/           — Commander CLI (bin: ysa)
  db/            — Drizzle schema + migrations (~/.ysa/core.db)
  dashboard/     — React components (props-based, no internal tRPC)
  lib/           — resources, resource-poller
  providers/     — Claude, Mistral adapters + registry
  runtime/       — sandbox orchestration (runner, container, proxy, worktree, auth)
  server/        — Hono app
client/          — React entry (wires tRPC to dashboard components)
container/       — Containerfile, seccomp, sandbox scripts
container/tests/ — security test suites and tooling (attack-test, network-proxy-test, benchmark, monitor, preflight)
```

## Config

All config in SQLite (`~/.ysa/core.db`), no `.env` needed. Config table: `project_root`, `default_model`, `default_network_policy`, `preferred_terminal`.

Worktrees always at `${project_root}/.ysa/worktrees/`. DB and logs at `${project_root}/.ysa/`.

## Adding a provider

Implement `ProviderAdapter` from `src/providers/types.ts`, register in `src/providers/registry.ts`.

## Migrations

Add a SQL file in `src/db/migrations/` and update `meta/_journal.json`. Never modify existing migration files.

## Rules

- No over-engineering — keep it simple
- No unnecessary comments or docstrings on unchanged code
- Shell scripts: bash 3.2 compatible (no associative arrays, no bash 4+ features)
- `/tmp` is symlinked to `/private/tmp` on macOS — use `$HOME/.cache/` for bind mounts if needed
