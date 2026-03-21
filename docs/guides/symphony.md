# Symphony + ysa

::: warning Experimental
This guide has not been fully tested end-to-end. Treat it as a reference for the integration approach — validate before using in production.
:::

[OpenAI Symphony](https://github.com/openai/symphony) is an orchestration daemon that monitors a Linear project, picks up issues automatically, and runs coding agents against them. It handles scheduling, retries, stall detection, and PR delivery — but provides no sandboxing of its own.

ysa fills that gap: every agent task runs inside a hardened Podman container with a seccomp profile, network proxy, and a git worktree isolated from your main branch.

There are two ways to combine them:

**Option A — Elixir Symphony + runner shim**: Use the official Elixir reference implementation and point its `codex.command` at a small TypeScript adapter that calls `runTask()`.

**Option B — TypeScript orchestrator** *(recommended)*: Reimplement the Symphony spec natively in TypeScript and call `runTask()` directly. No Elixir, no protocol translation. [Jump to that section.](#alternative-typescript-orchestrator)

## How Symphony runs agents

Symphony spawns any subprocess that speaks its JSON protocol over stdout. The default is `codex app-server` but it is not required — the spec is open and the command is configurable per workflow.

The protocol is a small JSON-RPC-like handshake:

```
initialize  →  initialized
thread/start
turn/start  →  (agent works)  →  turn/completed | turn/failed
```

The runner shim below implements this protocol and delegates execution to ysa's `runTask()`.

::: info Codex support
Native Codex support is planned. Today, use the runner shim below to run tasks via Claude or Mistral inside a ysa container.
:::

::: tip Not using Elixir?
If you'd rather skip the Elixir setup entirely, jump to [Option B](#alternative-typescript-orchestrator) — a native TypeScript orchestrator that calls `runTask()` directly with no protocol translation needed.
:::

## Prerequisites

- ysa installed and `ysa setup` completed
- Symphony deployed and connected to a Linear project — see [Symphony README](https://github.com/openai/symphony)
- A Node.js/Bun environment for the runner shim

## The runner shim

Create a file called `ysa-symphony-runner.ts` in your project (or a dedicated repo):

```ts
#!/usr/bin/env bun
/**
 * ysa-symphony-runner
 *
 * Bridges the Symphony agent protocol to ysa's runTask() API.
 * Configure Symphony with: codex.command: bun ysa-symphony-runner.ts
 */
import { runTask } from "@ysa-ai/ysa/runtime";
import * as readline from "readline";
import * as crypto from "crypto";

const rl = readline.createInterface({ input: process.stdin });

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function main() {
  let threadId: string | null = null;
  let cwd: string = process.cwd();

  for await (const line of rl) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    // Handshake
    if (msg.method === "initialize") {
      send({ method: "initialized", params: {} });
      continue;
    }

    if (msg.method === "thread/start") {
      threadId = msg.params?.threadId ?? crypto.randomUUID();
      cwd = msg.params?.cwd ?? cwd;
      continue;
    }

    if (msg.method === "turn/start") {
      const turnId: string = msg.params?.turnId ?? crypto.randomUUID();
      const prompt: string = msg.params?.input?.[0]?.text ?? "";
      cwd = msg.params?.cwd ?? cwd;

      try {
        const result = await runTask({
          taskId: `${threadId}-${turnId}`,
          prompt,
          branch: "main",
          projectRoot: cwd,
          worktreePrefix: `${cwd}/.ysa/worktrees/`,
          networkPolicy: "strict",
        });

        if (result.status === "completed") {
          send({ method: "turn/completed", params: { threadId, turnId } });
        } else {
          send({
            method: "turn/failed",
            params: {
              threadId,
              turnId,
              reason: result.failure_reason ?? result.error ?? "unknown",
            },
          });
        }
      } catch (err: any) {
        send({
          method: "turn/failed",
          params: { threadId, turnId, reason: err?.message ?? "exception" },
        });
      }
    }
  }
}

main();
```

## WORKFLOW.md

In your Symphony workflow file, point `codex.command` at the runner:

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ABC
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]

agent:
  max_concurrent_agents: 5

codex:
  command: bun /path/to/ysa-symphony-runner.ts
  turn_timeout_ms: 3600000

hooks:
  before_run: "npm install"
---

You are working on the following issue: {{ issue.title }}

{{ issue.description }}

Complete the task, commit your changes, and open a pull request.
```

## Customizing the runner

### Network policy

The shim uses `networkPolicy: "strict"` by default, which routes all agent traffic through ysa's MITM proxy. For tasks that need no network access (pure code changes), switch to `"none"`:

```ts
networkPolicy: "none",
```

See the [Network guide](/guides/network) for details on strict mode and scoped allow rules.

### Provider and model

```ts
const result = await runTask({
  // ...
  provider: "mistral",
  model: "codestral-latest",
});
```

### Passing the issue title as context

Symphony makes the issue title available as `msg.params?.title`. You can prepend it to the prompt for better context:

```ts
const title: string = msg.params?.title ?? "";
const prompt = title
  ? `Issue: ${title}\n\n${msg.params?.input?.[0]?.text ?? ""}`
  : msg.params?.input?.[0]?.text ?? "";
```

## How it works end-to-end

1. Symphony polls Linear and finds an issue in the `Todo` state
2. It creates a workspace directory and spawns `ysa-symphony-runner`
3. The runner receives `turn/start` with the rendered prompt
4. `runTask()` creates a git worktree, starts a Podman container, and runs the agent
5. The agent reads the code, makes changes, commits, and opens a PR
6. The runner sends `turn/completed` — Symphony marks the run as succeeded
7. If the agent fails or times out, the runner sends `turn/failed` — Symphony retries with backoff

## Alternative: TypeScript orchestrator

The Elixir reference implementation is explicitly marked as prototype software by OpenAI. If you'd rather not run an Elixir service in your stack, the Symphony spec is language-agnostic and designed to be reimplemented.

Since ysa is already TypeScript/Bun, a native TypeScript orchestrator is a natural fit — and it would call `runTask()` directly without the protocol shim layer:

```
Linear API
  → TypeScript orchestrator (implements Symphony SPEC)
    → runTask() directly
      → Podman container → Claude or Mistral
```

The orchestrator needs to implement:
- Linear polling (fetch issues by state, detect transitions)
- Concurrency slots (max N tasks in parallel)
- State machine per issue (running → succeeded / failed → retry with backoff)
- Stall detection (kill + retry if no event for N ms)

The [Symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) defines the full contract. An agent can implement it from the spec directly.

::: info Coming soon
A ysa-native TypeScript orchestrator is planned. It will expose the same Linear → agent → PR pipeline as Symphony with `runTask()` as the execution primitive, no Elixir required.
:::

## Related

- [runTask() API reference](/api/run-task)
- [Network policies](/guides/network)
- [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)
