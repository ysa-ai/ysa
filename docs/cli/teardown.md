# ysa teardown

Remove the container and git worktree for a task.

## Usage

```
ysa teardown <task-id> [options]
```

`<task-id>` can be a full UUID or an 8-character prefix.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-p, --project <path>` | string | auto-detected git root | Project root directory |

## Examples

Clean up after reviewing a completed task:

```bash
ysa teardown ab12cd34
```

## Notes

- Removes the Podman container (if still running, it is stopped first).
- Removes the git worktree at `<project>/.ysa/worktrees/<task-id>`.
- The branch created for the task is **not** deleted — merge or delete it manually.
- Log files are **not** removed.

## Related

- [`ysa stop`](./stop) — stop without removing the worktree
- [`ysa list`](./list) — find the task ID
