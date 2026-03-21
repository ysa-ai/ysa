# Providers

ysa supports multiple AI providers. Claude is the default; Mistral is also built in.

## Built-in providers

### Claude

```bash
ysa run "add tests" --provider claude  # (default, --provider flag not yet in CLI)
```

Auth: Set `CLAUDE_CODE_OAUTH_TOKEN` in your environment, or log in with `claude` CLI before running ysa.

Default model: `claude-sonnet-4-6`

### Mistral

Auth: Set `MISTRAL_API_KEY` in your environment.

Default model: `devstral-small-latest`

## Switching providers via API

```ts
await runTask({
  ...
  provider: "mistral",
  model: "devstral-small-latest",
});
```

## Switching providers via CLI

The CLI currently defaults to Claude. To use Mistral, use the API directly or set `default_model` in the ysa config database.

## Custom providers

See [Providers API reference](/api/providers) for how to implement and register a custom `ProviderAdapter`.

## Related

- [Providers API](/api/providers) — `ProviderAdapter` interface and `registerProvider`
- [RunConfig.provider](/api/run-task#runconfig-fields) — per-task provider selection
