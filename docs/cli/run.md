# ysa run

Run a coding task inside a sandboxed container with a fresh git worktree.

## Usage

```
ysa run <prompt> [options]
```

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-b, --branch <branch>` | string | `task-<timestamp>` | Base branch to create the worktree from |
| `-p, --project <path>` | string | auto-detected git root | Project root directory |
| `-m, --max-turns <n>` | number | `60` | Maximum agent turns before stopping |
| `-n, --network <policy>` | `none\|strict` | `none` | Network policy for the container |
| `-t, --tools <tools>` | string | — | Comma-separated allowed tools override |
| `-q, --quiet` | boolean | — | Show progress only, no agent output |
| `-v, --verbose` | boolean | — | Show full output including tool calls |
| `-i, --interactive` | boolean | — | Attach a live terminal session inside the sandbox |
| `--no-commit` | boolean | — | Prevent the agent from committing to git |

## Examples

Run a task with defaults:

```bash
ysa run "add unit tests for the auth module"
```

Run with a named branch and strict network:

```bash
ysa run "fetch and cache the exchange rate API" --branch feat/exchange-rate --network strict
```

Review-only task (no commits):

```bash
ysa run "review the error handling in src/api" --no-commit --quiet
```

Interactive sandbox session:

```bash
ysa run "debug the failing migration" --interactive
```

## Follow-up loop

After a task completes in a TTY, ysa prompts for an optional follow-up. Type a follow-up instruction to run another turn in the same session/worktree, or press Enter to exit.

## Related

- [`ysa refine`](./refine) — continue a task by ID
- [`ysa logs`](./logs) — view task output after it finishes
