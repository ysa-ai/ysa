# ysa setup

First-run setup: checks prerequisites, generates the CA cert, verifies container images, installs OCI network hooks, and runs a smoke test.

## Usage

```
ysa setup
```

No arguments or options.

## What it does

| Step | Description |
|------|-------------|
| 1. Preflight | Checks Podman 5.x+ is installed and rootless mode is enabled |
| 2. CA cert | Generates the mTLS CA at `~/.ysa/proxy-ca/` (skips if already present) |
| 3. Container images | Checks `sandbox-claude`, `sandbox-mistral`, `sandbox-proxy` exist — builds any missing images automatically |
| 4. OCI network hooks | Installs Podman network hooks needed for the proxy |
| 5. Smoke test | Starts and stops the proxy to verify everything works end-to-end |

## Notes

- Run this once after installing ysa, and again after upgrading.
- If an image build fails, you can retry with `bun run build:images` from the repo root, then re-run `ysa setup`.
- The CA cert at `~/.ysa/proxy-ca/ca.pem` is injected into every container so the mTLS proxy can inspect HTTPS traffic.

## Related

- [First Task guide](/guides/first-task) — full install walkthrough
- [`ysa runtime`](./runtime) — configure sandbox runtimes after setup
