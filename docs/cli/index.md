# CLI Overview

ysa ships a single binary (`ysa`) with 8 commands.

| Command | Description |
|---------|-------------|
| [`ysa run`](./run) | Run a task in a sandboxed container |
| [`ysa refine`](./refine) | Continue or refine a completed task |
| [`ysa list`](./list) | List tasks for the current project |
| [`ysa logs`](./logs) | View task output |
| [`ysa stop`](./stop) | Stop a running task |
| [`ysa teardown`](./teardown) | Remove container and worktree for a task |
| [`ysa runtime`](./runtime) | Manage sandbox runtimes (mise) |
| [`ysa setup`](./setup) | First-run setup |

## Global conventions

- **Task ID**: Every task has a UUID. Most commands accept a full UUID or an 8-character prefix.
- **Project root**: Auto-detected from the nearest git root. Override with `-p <path>`.
- **Output**: By default, commands stream the first line of each assistant message. Use `-q` for progress-only or `-v` for full tool call output.
