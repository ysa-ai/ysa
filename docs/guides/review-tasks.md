# Review Tasks

Use `--no-commit` to run the agent in analysis or review mode without letting it modify git history.

## When to use this

- Code review: "what are the potential security issues in this module?"
- Architecture analysis: "explain how the auth flow works"
- Test planning: "what edge cases should we test for the payment processor?"
- Any task where you want agent output but don't want code changes committed

## Usage

**CLI:**

```bash
ysa run "review the error handling in src/api and list what's missing" --no-commit
```

**API:**

```ts
await runTask({
  ...
  allowCommit: false,
});
```

## What changes

With `--no-commit` / `allowCommit: false`:

- The `Bash` tool is still available — the agent can read files, run tests, etc.
- The agent cannot run `git commit`, `git push`, or related commands (the tool is removed from its allowed set)
- The worktree still exists after the task — you can inspect any files the agent created or modified

## Combining with quiet mode

For analysis tasks where you only care about the final answer:

```bash
ysa run "summarize the database schema" --no-commit --quiet
```

`--quiet` suppresses the streaming output and only shows progress markers, so the final agent message is the first thing you read after the task completes.

## Reviewing the output

```bash
ysa logs <task-id> | jq 'select(.type == "assistant") | .text'
```

Or just:

```bash
ysa logs <task-id>
```

## Related

- [`ysa run`](/cli/run) — full CLI reference
- [RunConfig.allowCommit](/api/run-task#runconfig-fields) — API reference
