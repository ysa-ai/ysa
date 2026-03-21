# API Overview

ysa exposes a TypeScript API for programmatic use — useful when you need to drive tasks from your own code rather than the CLI.

## When to use the API

Use the CLI for running tasks directly. Use the API when you're building your own orchestration layer on top of ysa — a platform, a custom workflow, or any application that drives tasks programmatically.

## Installation

```bash
npm install @ysa-ai/ysa
```

## Quick example

```ts
import { runTask } from "@ysa-ai/ysa/runtime";
import type { RunConfig } from "@ysa-ai/ysa/types";

const result = await runTask(
  {
    taskId: crypto.randomUUID(),
    prompt: "add a health check endpoint",
    branch: "feat/health-check",
    projectRoot: "/home/user/myapp",
    worktreePrefix: "/home/user/myapp/.ysa/worktrees/",
  },
  {
    onProgress: (msg) => console.log(msg),
    onEvent: (event) => {
      if (event.type === "assistant") console.log("→", event.text);
    },
  }
);

console.log(result.status); // "completed" | "failed" | "stopped"
```

## Exports

| Import path | What it exports |
|-------------|-----------------|
| `@ysa-ai/ysa/runtime` | `runTask`, `runInteractive`, container/proxy utilities |
| `@ysa-ai/ysa/types` | `RunConfig`, `RunResult`, `TaskStatus`, `TaskState` |
| `@ysa-ai/ysa/db` | Database access (Drizzle ORM) |
| `@ysa-ai/ysa/api` | tRPC router (for embedding the server) |
| `@ysa-ai/ysa/dashboard` | React dashboard components |
