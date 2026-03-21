# ysa runtime

Manage sandbox runtimes (via [mise](https://mise.jdx.dev/)) for the current project. Changes are persisted to `.ysa.toml`.

## Usage

```
ysa runtime <action> [tool] [options]
```

| Action | Description |
|--------|-------------|
| `add <tool@version>` | Add a runtime to the sandbox |
| `remove <tool>` | Remove a runtime |
| `list` | Show all configured runtimes and packages |
| `detect` | Auto-detect runtimes from the project and write to `.ysa.toml` |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-p, --project <path>` | string | auto-detected git root | Project root directory |

## Examples

Add Node.js 22:

```bash
ysa runtime add node@22
```

Auto-detect from the project (reads `package.json`, `pyproject.toml`, `go.mod`, etc.):

```bash
ysa runtime detect
```

List what's configured:

```bash
ysa runtime list
```

Remove a runtime:

```bash
ysa runtime remove node
```

## Notes

- Runtimes are installed inside the container at task start using mise. They are not installed on your host.
- The `.ysa.toml` file should be committed to the repo so all team members use the same sandbox runtimes.
- Apt packages can also be added via `.ysa.toml` directly — see the [Runtimes guide](/guides/runtimes).

## Related

- [Runtimes guide](/guides/runtimes) — full `.ysa.toml` reference
- [`ysa setup`](./setup) — first-run setup
