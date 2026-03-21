# Network Policies

ysa controls what the agent can access over the network via a MITM proxy that runs as a separate `sandbox-proxy` container.

## Policies

| Policy | Description |
|--------|-------------|
| `none` | No proxy — the container has no outbound network access |
| `strict` | All traffic routes through the proxy, which enforces the rules below |

## Setting the policy

**CLI:**

```bash
ysa run "fetch the latest exchange rates" --network strict
```

**API:**

```ts
await runTask({
  ...
  networkPolicy: "strict",
});
```

## How the proxy works

When `networkPolicy: "strict"`, a `sandbox-proxy` container starts on port 3128 and all agent traffic routes through it. The proxy:

- **Terminates TLS** (HTTPS CONNECT): generates a per-host certificate signed by the local CA (created during `ysa setup`) and inspects the decrypted request before forwarding. This is how policy is enforced on HTTPS traffic.
- **Allows GET only** by default — all other HTTP methods are blocked.
- **Blocks request bodies** — prevents sending data out via POST/PUT.
- **Limits URL length** to 200 characters (path + query) — blocks data encoded in URLs.
- **Detects base64 and hex patterns** in URL path segments — blocks exfiltration attempts encoded in paths.
- **Strips non-standard headers** — only standard HTTP headers are forwarded.
- **Rate limits** requests: 30 req/min per domain, max 10 in any 5-second window, 50 KB/min outbound per domain, 300 req/min and 500 KB/min globally across all domains per task.
- **Logs every request** (ALLOW/BLOCK) to `~/.ysa/proxy-logs/<task-id>.log`.

## Always-bypassed hosts

Some hosts are tunneled through without MITM inspection regardless of policy:

| Category | Hosts |
|----------|-------|
| Claude (required for agent function) | `api.anthropic.com`, `statsig.anthropic.com` |
| Package registries | `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `static.crates.io` |

Bypassed hosts are tunneled directly — the proxy connects them without terminating TLS.

## Scoped allow rules

`ScopedAllowRule` entries bypass the method and body restrictions for specific host + path combinations. These are intended for MCP tool hosts where the agent needs POST access to a specific API path:

```ts
import type { ScopedAllowRule } from "@ysa-ai/ysa/runtime";

const rules: ScopedAllowRule[] = [
  { host: "api.example.com", pathPrefix: "/v1/projects/my-project/" },
];

await runTask({
  ...
  networkPolicy: "strict",
  proxyRules: rules,
});
```

A scoped rule allows **all HTTP methods** (GET, POST, PUT, etc.) for requests whose host matches and whose path starts with `pathPrefix`. Everything else still goes through the default strict policy.

## none (default)

The container has no outbound network access at all — no proxy is started and the OCI network hooks block all outbound connections. Use this for pure code generation tasks.

## Related

- [`ysa run --network`](/cli/run) — set the policy from the CLI
- [RunConfig.proxyRules](/api/run-task#runconfig-fields) — per-task scoped allow rules
