# ysa refine

Continue or refine a completed task by resuming its agent session in the existing worktree.

## Usage

```
ysa refine <task-id> <prompt> [options]
```

`<task-id>` can be a full UUID or an 8-character prefix.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-p, --project <path>` | string | auto-detected git root | Project root directory |
| `-q, --quiet` | boolean | — | Show progress only, no agent output |
| `-v, --verbose` | boolean | — | Show full output including tool calls |
| `-i, --interactive` | boolean | — | Attach a live terminal session |
| `--no-commit` | boolean | — | Prevent the agent from committing to git |

## Examples

Add to a completed task:

```bash
ysa refine ab12cd34 "also add error handling for the edge case we missed"
```

Refine interactively:

```bash
ysa refine ab12cd34 "let's review what you did" --interactive
```

## Notes

- Only works on tasks that completed with a Claude session ID (visible in `ysa logs <id>`).
- The agent resumes in the same worktree — files the previous task created are still there.
- The branch is automatically set to `task/<task-id-prefix>`.

## Related

- [`ysa run`](./run) — start a new task
- [`ysa logs`](./logs) — inspect the session ID before refining
