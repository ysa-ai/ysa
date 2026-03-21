# ysa stop

Stop a running task (sends SIGTERM to the container).

## Usage

```
ysa stop <task-id> [options]
```

`<task-id>` can be a full UUID or an 8-character prefix.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-p, --project <path>` | string | auto-detected git root | Project root directory |

## Examples

Stop a task:

```bash
ysa stop ab12cd34
```

## Notes

- The task status moves to `stopped`.
- The worktree and container are not removed — use [`ysa teardown`](./teardown) for that.
- Files the agent created before being stopped are preserved in the worktree.

## Related

- [`ysa teardown`](./teardown) — remove the container and worktree after stopping
- [`ysa list`](./list) — find the task ID
