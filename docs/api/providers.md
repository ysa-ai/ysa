# Providers

ysa abstracts AI providers behind a `ProviderAdapter` interface. Claude and Mistral are built in.

## Built-in providers

| Provider name | Default model | Notes |
|---------------|---------------|-------|
| `"claude"` | `claude-sonnet-4-6` | Uses `CLAUDE_CODE_OAUTH_TOKEN` |
| `"mistral"` | `devstral-small-latest` | Uses `MISTRAL_API_KEY` |

Pass the provider name in `RunConfig.provider`:

```ts
await runTask({
  ...
  provider: "mistral",
  model: "devstral-small-latest",
});
```

## Custom providers

Custom provider support is coming soon.

## Related

- [Providers guide](/guides/providers) — switching providers per task
