# Providers

ysa supports multiple AI providers. Claude is the default.

## Built-in providers

### Claude

```bash
ysa run "add tests"                          # defaults to Claude
ysa run "add tests" --provider claude
```

Auth: Log in with the `claude` CLI before running ysa (`claude login`). The OAuth token is picked up automatically.

Default model: `claude-sonnet-4-6`

### DeepSeek

```bash
ysa run "add tests" --provider deepseek
```

Auth: Store your API key with:

```bash
ysa key set deepseek
```

DeepSeek uses Claude Code's API protocol (`api.deepseek.com/anthropic`) so the same agent binary works without modification.

Default model: `deepseek-v4-pro` (sub-agent tasks use `deepseek-v4-flash`)

### Mistral

```bash
ysa run "add tests" --provider mistral
```

Auth: Store your API key with:

```bash
ysa key set mistral
```

Default model: `devstral-small-latest`

## Managing API keys

```bash
ysa key set <provider>     # prompt for key and store it securely
ysa key check <provider>   # verify a key is stored
ysa key delete <provider>  # remove a stored key
```

## Switching providers via API

```ts
await runTask({
  ...
  provider: "deepseek",
});
```

## Custom providers

See [Providers API reference](/api/providers) for how to implement and register a custom `ProviderAdapter`.

If your provider's API endpoint requires direct TCP access (bypassing the proxy), set `bypassHosts` on the adapter:

```ts
export const myAdapter: ProviderAdapter = {
  ...
  bypassHosts: ["api.myprovider.com"],
};
```

## Related

- [Providers API](/api/providers) — `ProviderAdapter` interface and `registerProvider`
- [RunConfig.provider](/api/run-task#runconfig-fields) — per-task provider selection
- [`ysa run --provider`](/cli/run) — CLI flag
