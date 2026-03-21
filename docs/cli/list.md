# ysa list

List tasks for the current project, with their status and short ID.

## Usage

```
ysa list [options]
ysa ls [options]
```

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-s, --status <status>` | `running\|done` | — | Filter by status |
| `-p, --project <path>` | string | auto-detected git root | Project root directory |

## Examples

List all tasks:

```bash
ysa list
```

Show only running tasks:

```bash
ysa list --status running
```

## Output

Each row shows the task ID prefix, status, elapsed time, and the first line of the prompt.

## Related

- [`ysa logs`](./logs) — view full output for a task
- [`ysa stop`](./stop) — stop a running task
