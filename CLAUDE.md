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

## Git workflow

- **Never push directly to `main`** except for trivial doc/typo fixes
- All changes go through a PR — even solo work
- `main` is always releasable

### PR naming convention

```
<type>: <short description>
```

| Type | When to use |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `chore` | Tooling, deps, config, CI |
| `refactor` | Code change with no behavior change |
| `docs` | Documentation only |
| `test` | Tests only |
| `perf` | Performance improvement |

Examples: `feat: add Mistral provider`, `fix: worktree cleanup on crash`, `chore: bump bun to 1.2.5`

### Versioning & releases

Releases are **git tags** on `main`, no long-lived version branches. Version branches only if backporting fixes to an old major.

Release flow:
```bash
npm version patch   # or minor / major — bumps package.json + creates git tag
git push --follow-tags
npm publish
gh release create v<x.y.z> --generate-notes
```

Use `gh release create --generate-notes` to auto-generate release notes from merged PR titles — this is why PR titles matter.

## Rules

- No over-engineering — keep it simple
- No unnecessary comments or docstrings on unchanged code
- Shell scripts: bash 3.2 compatible (no associative arrays, no bash 4+ features)
- `/tmp` is symlinked to `/private/tmp` on macOS — use `$HOME/.cache/` for bind mounts if needed
