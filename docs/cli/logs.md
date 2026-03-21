# ysa logs

View the raw log output for a task.

## Usage

```
ysa logs <task-id> [options]
```

`<task-id>` can be a full UUID or an 8-character prefix.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --follow` | boolean | — | Follow log output (like `tail -f`) |
| `--tail <n>` | number | — | Show only the last N lines |
| `-p, --project <path>` | string | auto-detected git root | Project root directory |

## Examples

View all logs for a task:

```bash
ysa logs ab12cd34
```

Follow a running task in real time:

```bash
ysa logs ab12cd34 --follow
```

Show only the last 50 lines:

```bash
ysa logs ab12cd34 --tail 50
```

## Notes

Logs are stored as newline-delimited JSON at `<project>/.ysa/logs/<task-id>.log`. Each line is a structured event (assistant message, tool call, system event).

## Related

- [`ysa list`](./list) — find task IDs
- [`ysa refine`](./refine) — continue a task after reviewing its output
