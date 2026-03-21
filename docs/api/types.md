# Types

Core type definitions from `@ysa-ai/ysa/types`.

## TaskStatus

```ts
type TaskStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "archived";
```

## TaskState

Full state of a task (as stored in the database):

```ts
interface TaskState {
  task_id: string;          // UUID
  prompt: string;
  status: TaskStatus;
  branch: string;
  worktree: string;         // absolute path
  session_id: string | null;
  error: string | null;
  failure_reason: "max_turns" | "infrastructure" | "agent_aborted" | null;
  log_path: string;
  started_at: string;       // ISO 8601
  finished_at: string | null;
}
```

## RunConfig

What you pass to `runTask()`. See the [runTask reference](/api/run-task#runconfig-fields) for full field descriptions.

```ts
interface RunConfig {
  taskId: string;
  prompt: string;
  branch: string;
  projectRoot: string;
  worktreePrefix: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  resumeSessionId?: string;
  resumePrompt?: string;
  resumeWorktree?: string;
  networkPolicy?: "none" | "strict";
  promptUrl?: string;
  shadowDirs?: string[];
  miseVolume?: string;
  worktreeFiles?: string[];
  extraEnv?: Record<string, string>;
  extraLabels?: Record<string, string>;
  proxyRules?: ScopedAllowRule[];
  serverPort?: number;
  allowCommit?: boolean;
}
```

## RunResult

What `runTask()` returns:

```ts
interface RunResult {
  task_id: string;
  status: TaskStatus;
  session_id: string | null;
  error: string | null;
  failure_reason: "max_turns" | "infrastructure" | "agent_aborted" | null;
  log_path: string;
  duration_ms: number;
}
```

## CoreConfig

Minimal config for embedding ysa in a platform:

```ts
interface CoreConfig {
  projectRoot: string;
  worktreePrefix: string;
  branchPrefix: string;
  dataDir: string; // e.g. ~/.ysa/
}
```

## ParsedLogEntry

Structured log event emitted via `onEvent`:

```ts
interface ParsedLogEntry {
  type: "assistant" | "tool_call" | "tool_result" | "system";
  text?: string;
  tool?: string;
}
```
