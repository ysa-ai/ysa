# Dependency Cache

Each task runs in a fresh container, but installing dependencies from scratch on every task is slow. The dep cache lets you pre-install dependencies into a named Podman volume that is reused across tasks — as long as the lockfiles haven't changed.

## How it works

1. Before the agent container starts, ysa runs `depInstallCmd` in a temporary container mounted against the project worktree.
2. The installed dependencies land in a shadow volume (`shadow-<dir>-<cacheKey>`).
3. That volume is mounted into the agent container at `/workspace/<shadowDir>` — so dependencies are available immediately when the agent starts.
4. On subsequent tasks with the same `depsCacheKey`, the volume already exists and the install step is skipped entirely.
5. When the key changes (lockfile updated), a new volume is created and the old one is cleaned up on the next task spawn.

## Minimal example

```ts
import { createHash } from "crypto";
import { readFileSync } from "fs";

const lockHash = createHash("sha1")
  .update(readFileSync("bun.lockb"))
  .digest("hex")
  .slice(0, 16);

const handle = await runTask({
  taskId: crypto.randomUUID(),
  prompt: "add tests for the auth module",
  branch: "main",
  projectRoot: "/home/user/myapp",
  worktreePrefix: "/home/user/myapp/.ysa/worktrees/",
  depInstallCmd: "bun install",
  depsCacheKey: lockHash,
});
```

## Fields

| Field | Description |
|-------|-------------|
| `depInstallCmd` | Command to run inside the container to install dependencies (e.g. `"bun install"`, `"npm ci"`, `"pip install -r requirements.txt"`). Runs before the agent starts. |
| `depsCacheKey` | Stable string that identifies the current dep state. When this key matches an existing volume, install is skipped. Pass a hash of your lockfiles so the cache invalidates when deps change. |
| `shadowDirs` | Directories to shadow with per-task volumes. Defaults to `["node_modules"]`. The first entry is where `depInstallCmd` installs into. |

## Volume naming

Volumes are named `shadow-<dir>-<depsCacheKey>`, where `<dir>` is the first entry in `shadowDirs` with slashes replaced by dashes. For example:

- `shadowDirs: ["node_modules"]`, `depsCacheKey: "a1b2c3d4e5f6a7b8"` → `shadow-node_modules-a1b2c3d4e5f6a7b8`
- `shadowDirs: ["vendor/bundle"]`, `depsCacheKey: "a1b2c3d4e5f6a7b8"` → `shadow-vendor-bundle-a1b2c3d4e5f6a7b8`

`handle.shadowVolumes` contains the exact volume names used by the task — available immediately after spawn, before the container finishes. This lets an orchestration layer record which volumes are in use and clean up stale ones safely.

## Stale volume cleanup

When you run many tasks over time, old dep cache volumes accumulate. The recommended pattern for orchestrators:

1. After `runTask` returns the handle, store `handle.shadowVolumes` (the current task's volumes).
2. Query your task store for volumes used by other running or recently stopped tasks.
3. List all Podman volumes matching `shadow-*-<16 hex chars>`.
4. Remove any that aren't in the protected set.

```ts
const handle = await runTask(config, { onComplete, onError });

// Store volumes before container finishes
const currentVolumes = handle.shadowVolumes;
await storeTaskVolumes(handle.taskId, currentVolumes);

// Clean stale volumes (don't remove anything still in use)
const inUse = await getVolumesInUse(); // from your task store
const protectedSet = new Set([...currentVolumes, ...inUse]);
const allVolumes = await listPodmanVolumes();
for (const vol of allVolumes) {
  if (/^shadow-.*-[a-f0-9]{16}$/.test(vol) && !protectedSet.has(vol)) {
    await podman("volume", "rm", vol);
  }
}
```

## Caching multiple directories

To cache more than one directory (e.g. both `node_modules` and `.cache`):

```ts
const handle = await runTask({
  // ...
  depInstallCmd: "bun install",
  depsCacheKey: lockHash,
  shadowDirs: ["node_modules", ".cache"],
});
```

Only the first directory in `shadowDirs` is used for the dep cache volume. Additional directories get per-task volumes (not shared across tasks).
