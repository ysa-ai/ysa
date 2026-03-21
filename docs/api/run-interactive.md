# runInteractive()

Start a sandboxed container and attach stdin/stdout for a live terminal session.

## Signature

```ts
function runInteractive(config: RunConfig): Promise<void>
```

Takes the same `RunConfig` as [`runTask()`](./run-task) but does not accept `RunOptions` (there is no streaming — you are attached directly to the terminal).

## Example

```ts
import { runInteractive } from "@ysa-ai/ysa/runtime";

await runInteractive({
  taskId: crypto.randomUUID(),
  prompt: "help me debug the failing tests",
  branch: "debug/tests",
  projectRoot: "/home/user/myapp",
  worktreePrefix: "/home/user/myapp/.ysa/worktrees/",
  provider: "claude",
  networkPolicy: "none",
});
```

## Notes

- The process inherits the calling terminal's dimensions.
- Exits when the user closes the session (Ctrl+D or `exit`).
- The worktree persists after the session ends — use [`ysa teardown`](/cli/teardown) to clean up.
- Does not return a `RunResult`. If you need the result, use [`runTask()`](./run-task) instead.

## Related

- [`runTask()`](./run-task) — non-interactive task runner with streaming callbacks
- [`ysa run --interactive`](/cli/run) — CLI equivalent
