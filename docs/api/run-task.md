# runTask()

Run a coding task inside a sandboxed container.

## Signature

```ts
function runTask(config: RunConfig, options?: RunOptions): Promise<RunResult>
```

```ts
interface RunOptions {
  onProgress?: (message: string) => void;
  onEvent?: (event: ParsedLogEntry) => void;
}
```

## Minimal example

```ts
import { runTask } from "@ysa-ai/ysa/runtime";

const result = await runTask({
  taskId: crypto.randomUUID(),
  prompt: "refactor the database connection pool",
  branch: "refactor/db-pool",
  projectRoot: "/home/user/myapp",
  worktreePrefix: "/home/user/myapp/.ysa/worktrees/",
});
```

## RunConfig fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `taskId` | `string` | required | Caller-assigned UUID for this task |
| `prompt` | `string` | required | Instructions for the agent |
| `branch` | `string` | required | Base branch to create the worktree from. The actual worktree branch is always `task/<taskId[:8]>` |
| `projectRoot` | `string` | required | Absolute path to the project root |
| `worktreePrefix` | `string` | required | Directory where worktrees are created (e.g. `<root>/.ysa/worktrees/`) |
| `provider` | `string` | `"claude"` | Provider name. See [Providers](/api/providers) |
| `model` | `string` | provider default | Model ID within the provider |
| `maxTurns` | `number` | `60` | Maximum agent turns before stopping with `failure_reason: "max_turns"` |
| `allowedTools` | `string[]` | provider default | Override the tool whitelist |
| `resumeSessionId` | `string` | — | Resume an existing session (for refine/continue) |
| `resumePrompt` | `string` | — | Custom prompt when resuming a session |
| `resumeWorktree` | `string` | — | Reuse an existing worktree path (skips creation) |
| `networkPolicy` | `"none"\|"strict"` | `"none"` | Container network policy. See [Network guide](/guides/network) |
| `promptUrl` | `string` | — | URL the container fetches the prompt from (used by the platform) |
| `shadowDirs` | `string[]` | `["node_modules"]` | Directories shadowed with per-task volumes |
| `miseVolume` | `string` | — | Pre-populated mise-installs volume to mount |
| `worktreeFiles` | `string[]` | — | Untracked files to copy from project root into the worktree |
| `extraEnv` | `Record<string, string>` | — | Extra environment variables injected into the container |
| `extraLabels` | `Record<string, string>` | — | Additional Podman labels on the container. Used by `stopContainer`/`teardownContainer` to target specific containers |
| `proxyRules` | `ScopedAllowRule[]` | — | Per-task proxy allow rules. Each rule has `host` and `pathPrefix` fields |
| `serverPort` | `number` | — | Host server port to bypass in the network proxy (e.g. dashboard port) |
| `allowCommit` | `boolean` | `true` | Whether the agent can commit to git |

## RunResult fields

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | `string` | The task UUID |
| `status` | `TaskStatus` | Final status: `"completed"`, `"failed"`, or `"stopped"` |
| `session_id` | `string \| null` | Agent session ID (useful for `resumeSessionId` in a follow-up) |
| `error` | `string \| null` | Error message if `status === "failed"` |
| `failure_reason` | `"max_turns" \| "infrastructure" \| "agent_aborted" \| null` | Structured failure reason |
| `log_path` | `string` | Absolute path to the NDJSON log file |
| `duration_ms` | `number` | Wall-clock duration in milliseconds |

## Streaming output

```ts
await runTask(config, {
  onProgress: (msg) => {
    // Lifecycle messages: "creating worktree", "starting container", etc.
    console.log("[progress]", msg);
  },
  onEvent: (event) => {
    // Structured log entries from the agent
    if (event.type === "assistant" && event.text) {
      process.stdout.write(event.text);
    }
    if (event.type === "tool_call") {
      console.log(`[tool] ${event.tool}`);
    }
  },
});
```

`ParsedLogEntry` has `type: "assistant" | "tool_call" | "tool_result" | "system"`, plus optional `text` and `tool` fields.

## Container lifecycle

Two utilities let you manage running containers from outside `runTask()`.

### stopContainer()

Stop and remove a running container, returning the agent session ID (for later resume).

```ts
import { stopContainer } from "@ysa-ai/ysa/runtime";

const sessionId = await stopContainer(taskId, {
  logPath: "/path/to/task.log",   // used to extract sessionId
  provider: "claude",              // defaults to "claude"
  labels: { issue: "42", project: "my-project" },  // match by labels
});

// sessionId can be passed as resumeSessionId in a follow-up runTask()
```

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string` | Task ID (used as fallback label filter if `labels` not provided) |
| `opts.logPath` | `string` | Path to the task log file — used to extract the session ID |
| `opts.provider` | `string` | Provider name for session ID extraction (default `"claude"`) |
| `opts.labels` | `Record<string, string>` | Match containers by these Podman labels. If omitted, filters by `label=task=<id>` |

### teardownContainer()

Remove a stopped or running container and its associated volumes.

```ts
import { teardownContainer } from "@ysa-ai/ysa/runtime";

await teardownContainer(taskId, {
  labels: { issue: "42", project: "my-project" },
});
```

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string` | Task ID — also used to match volumes (volumes named `*-<id>`) |
| `opts.labels` | `Record<string, string>` | Match containers by these Podman labels. If omitted, filters by `label=task=<id>` |

### Using extraLabels for lifecycle management

Pass `extraLabels` to `runTask()` so you can later target that container by your own identifiers:

```ts
const result = await runTask({
  taskId,
  // ...
  extraLabels: { issue: "42", phase: "analyze", project: "my-project" },
});

// Later, stop just the analyze container for issue 42:
await stopContainer(taskId, {
  labels: { issue: "42", phase: "analyze" },
});
```

Containers always have a `task=<taskId>` label set automatically. `extraLabels` are additive.

## Related

- [`runInteractive()`](./run-interactive) — for live terminal sessions
- [Types reference](./types) — full type definitions
