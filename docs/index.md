---
layout: home
hero:
  name: ysa
  text: AI agents in isolated containers
  tagline: Run Claude, Mistral, and other agents in parallel — sandboxed, local, fully auditable.
  actions:
    - theme: brand
      text: First Task →
      link: /guides/first-task
    - theme: alt
      text: CLI Reference
      link: /cli/
    - theme: alt
      text: API Reference
      link: /api/
features:
  - title: Parallel execution
    details: Run multiple agents simultaneously across git worktrees, each isolated from the others.
  - title: Hardened containers
    details: Rootless Podman with seccomp, no-new-privileges, and a mTLS-inspecting proxy. Agents can't escape.
  - title: Fully local
    details: Everything runs on your machine. Auth tokens stay local. No telemetry.
---

## Quick start

```bash
npm install -g @ysa-ai/ysa
ysa setup
ysa run "add input validation to the login form"
```

See the [First Task guide](/guides/first-task) for a full walkthrough.
