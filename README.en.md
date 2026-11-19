<p align="center">
  <img src="docs/logo-ghost-wave-effect.svg" alt="Reasonix" width="360"/>
</p>

<p align="center"><strong>Personal fork · No longer maintained</strong></p>

<p align="center">
  <a href="./README.md">简体中文</a>
  &nbsp;·&nbsp;
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./docs/GUIDE.md">Guide</a>
  &nbsp;·&nbsp;
  <a href="./docs/ACP.md">ACP</a>
  &nbsp;·&nbsp;
  <a href="./docs/EXTENSIONS.md">Extensions</a>
  &nbsp;·&nbsp;
  <a href="./docs/SPEC.md">Spec</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
</p>

---

> [!WARNING]
> **This repository is no longer maintained.** The code is frozen; there will be no further releases, fixes or issue triage.
>
> This is a personal fork line: it branched from upstream DeepSeek-Reasonix v1.38.2, maintained both a Wails (1.x) and a Studio (2.x) line in parallel, and later focused on Wails. Both lines have moved out:
>
> - **[reasonix-wails](https://github.com/keeyangyy/reasonix-wails)**: continues the Wails line — a lightweight Windows single-exe desktop app.
> - **[reasonix-studio](https://github.com/keeyangyy/reasonix-studio)**: continues the 2.x line — the full-featured Electron desktop app.
>
> Upstream [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) was archived on 2026-11-12; its final release is v2.61.0.

## What this is

This repository is a personal fork line of Reasonix, not an official release. It branched from upstream v1.38.2, kept the Go + Wails desktop implementation, and evolved independently; release channels, feature choices and issue handling differ from upstream.

The line went through three stages:

- **Parallel stage**: maintained Wails (`wails-mine`, 1.x), Studio (`studio-mine`, 2.x Electron) and an earlier Electron line (`main-v2-mine`) at the same time.
- **Convergence stage**: after upstream moved its desktop app to Electron, this line focused on Wails and selectively absorbed upstream 1.x fixes.
- **End of maintenance**: the final Wails release is **v1.38.55** (2026-11-04), and the final Studio release is **v2.57.0** (2026-11-01). Further work continues in reasonix-wails and reasonix-studio.

Upstream copyright notices, the MIT license and contributor credits are retained.

## Features

- **Config-driven.** Providers, the agent, enabled tools, and plugins are all declared in `reasonix.toml`. No hardcoded models.
- **Multi-model & composable.** DeepSeek ships as a preset; any OpenAI-compatible endpoint is a config entry, not new code. Optionally run two models together (executor + planner) in separate, cache-stable sessions.
- **Plugin-driven.** MCP servers contribute tools, prompts, and resources; Extension Protocol v1 sidecars can also intercept runtime events, contribute Providers and structured UI, and ship versioned plugin packages.
- **Cache-aware context maintenance.** Startup injects a small stable environment summary, stale tool output is snipped/pruned before summary compaction, and the built-in tool schema contract is documented for regression review.
- **Zero-friction distribution.** `CGO_ENABLED=0` single binary; cross-compile to six targets with one command. The result is a fully self-contained static binary.

## Download and build

The [Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases) page keeps historical builds and is **no longer updated**. The final Wails release is `v1.38.55`; new users should use [reasonix-wails](https://github.com/keeyangyy/reasonix-wails); the Studio line is [reasonix-studio](https://github.com/keeyangyy/reasonix-studio).

### Historical installers

| Platform | Package | Architecture |
| --- | --- | --- |
| Windows | Installer `Reasonix-windows-amd64-installer.exe` or portable `Reasonix-windows-amd64-portable.zip` | x64 |

The installer is not Authenticode-signed, so Windows SmartScreen may warn on first launch. In-app updates are verified with this repository's minisign key.

### Build from source

```sh
git clone https://github.com/keeyangyy/DeepSeek-Reasonix.git
cd DeepSeek-Reasonix
```

#### CLI

The CLI build requires **Go 1.26+**. The module pins a `toolchain` directive; keep `GOTOOLCHAIN=auto` so Go downloads the pinned toolchain, or install it.

```sh
make build      # -> bin/reasonix(.exe)
make cross      # -> dist/ (darwin|linux|windows × amd64|arm64)
```

#### Desktop

The desktop app uses **Wails v2** (WebView2), not Electron. The build additionally requires:

- **Node 24+ and pnpm 10** (`npm install -g pnpm@10`) for the frontend
- **Wails CLI** matching the shared `.wails-version` pin

```sh
make wails-install
cd desktop
wails build
```

See the [desktop build guide](desktop/README.md#prerequisites) for platform webview dependencies and Linux build tags.

> The VS Code extension belongs to the upstream ecosystem and depends on the upstream CLI; this build does not ship a matching extension release.

## Quick start

The commands below apply to the historical builds in this repository.

### CLI / TUI

```sh
reasonix setup                      # configure a provider and model
reasonix                            # start an interactive session
reasonix run "implement the TODOs in main.go"
```

In an interactive session, run `/init` when you want Reasonix to create project instructions.

### Desktop app

Install and launch Reasonix, then configure a provider and model in the app.

> This build and the official release share `%APPDATA%\reasonix` and the same single-instance lock by default. To run both side by side, set a separate `REASONIX_HOME` for one of them.

> Historical builds may still keep upstream's anonymous launch telemetry and crash-report settings; both can be disabled in settings. `reasonix upgrade` points at the upstream release source and should not be used with this build.

## Documentation

- **Getting started:** [Guide](./docs/GUIDE.md) · [CLI reference](./docs/CLI.md) · [Configuration paths](./docs/CONFIG_PATHS.md) · [ACP editor integration](./docs/ACP.md)
- **Features & troubleshooting:** [Subagent profiles](./docs/SUBAGENT_PROFILES.md) · [Context Engine v2](./docs/SESSION_MEMORY_RETRIEVAL.md) · [Capability diagnostics](./docs/CAPABILITY_DIAGNOSTICS.md) · [Recovery and updates](./docs/RECOVERY.md) · [Bot guide](./docs/BOT_GUIDE.md) · [Checkpoints & rewind](./docs/CHECKPOINTS.md)
- **Engineering & migration:** [Spec](./docs/SPEC.md) · [Task contracts & pause policy](./docs/TASK_CONTRACT.md) · [Tool contract](./docs/TOOL_CONTRACT.md) · [Migrating from 0.x](./docs/MIGRATING.md)
- **Extension development:** [Extensions](./docs/EXTENSIONS.md) · [Plugin packages and Manifest v1](./docs/PLUGIN_PACKAGES.md) · [Extension Protocol](./docs/EXTENSION_PROTOCOL.md) · [Go SDK and starter](./sdk/go/README.md)

## Acknowledgments

This project is based on the 1.x code of [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) and remains under the MIT License. Thanks to the original author and all upstream contributors; the full list is on the [upstream contributor graph](https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors?all=1).

The project logo was designed by [Bernardxu123](https://github.com/Bernardxu123).

---

<p align="center">
  <sub>MIT — see <a href="./LICENSE">LICENSE</a></sub>
</p>
