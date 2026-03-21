# Runtimes & .ysa.toml

ysa uses [mise](https://mise.jdx.dev/) to install language runtimes inside the container. Configure them with `ysa runtime` commands or by editing `.ysa.toml` directly.

## .ysa.toml format

```toml
[sandbox]
runtimes = ["node@22", "python@3.12"]
packages = ["libpq-dev", "imagemagick"]
```

- `runtimes` — mise tool specs installed on container start
- `packages` — apt packages installed on container start

Commit `.ysa.toml` to your repo so all team members and CI use the same sandbox.

## Supported languages

`ysa runtime detect` recognises these languages and maps them to mise tools automatically:

| Language | Detected from | Default version |
|----------|---------------|-----------------|
| Node.js | `package.json` | `node@22` |
| Python | `pyproject.toml`, `requirements.txt`, `Pipfile` | `python@3.13` |
| Go | `go.mod` | `go@1` |
| Rust | `Cargo.toml` | `rust@1` |
| Ruby | `Gemfile` | `ruby@3.3` |
| PHP | `composer.json` | `php-cli` (apt) |
| Java (Maven) | `pom.xml` | `java@21` + `maven@3` |
| Java (Gradle) | `build.gradle`, `build.gradle.kts` | `java@21` + `gradle@8` |
| .NET | `*.csproj`, `*.sln` | `dotnet@8` |
| Elixir | `mix.exs` | `elixir@1.18` |
| C/C++ | `CMakeLists.txt` | `g++` (apt) |

Any tool supported by [mise](https://mise.jdx.dev/plugins.html) can also be added manually with `ysa runtime add <tool@version>`.

**Why some languages use apt instead of mise:** mise installs tools from precompiled binaries. When a precompiled binary isn't available for the container's platform, mise falls back to compiling from source — which is slow and often fails inside the sandbox. PHP and C/C++ compilers are more reliably provided by the system package manager. Elixir is installed via mise, but its Erlang/OTP dependency comes from apt because the mise Erlang plugin requires a matching OTP version that Debian packages more reliably than precompiled binaries cover.

## ysa runtime commands

### Detect from project files

```bash
ysa runtime detect
```

Reads `package.json`, `pyproject.toml`, `.python-version`, `go.mod`, `Gemfile`, `.tool-versions`, etc. and writes the detected runtimes to `.ysa.toml`.

### Add a runtime

```bash
ysa runtime add node@22
ysa runtime add python@3.12
ysa runtime add go@1.23
```

Any tool supported by mise works here.

### Remove a runtime

```bash
ysa runtime remove node
```

Removes all versions of `node` from the config.

### List configured runtimes

```bash
ysa runtime list
```

## How runtimes are installed

At the start of each task, if `.ysa.toml` is present, ysa:

1. Mounts a shared `mise-installs` volume into the container
2. Runs `mise install` for each configured tool
3. The tool binaries are available in `$PATH` for the agent

The volume is shared across tasks so runtimes don't re-download on every run.

## Adding apt packages

For system libraries the agent needs (e.g. `libpq-dev` for PostgreSQL, `ffmpeg`, `imagemagick`):

```toml
[sandbox]
packages = ["libpq-dev", "ffmpeg"]
```

Unlike `runtimes`, apt packages are baked into a **project-specific image** the first time a task runs. ysa builds `sandbox-proj-claude-<hash>` on top of the base `sandbox-claude` image and reuses it for all subsequent tasks in that project. This means the first task is slower (one-time image build), but all following tasks start at full speed.

## How images are layered

| Image | When used |
|-------|-----------|
| `sandbox-claude` | Base image — used when no apt `packages` are configured |
| `sandbox-mistral` | Same, for Mistral tasks |
| `sandbox-proj-claude-<hash>` | Derived image — built once when `packages` are set, reused after |

The hash is derived from the project root path, so each project gets its own derived image.

## Related

- [`ysa runtime`](/cli/runtime) — CLI reference
- [First Task guide](/guides/first-task) — setup walkthrough
