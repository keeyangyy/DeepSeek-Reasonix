<p align="center">
  <img src="docs/logo-ghost-wave-effect.svg" alt="Reasonix" width="360"/>
</p>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="./docs/GUIDE.md">Guide</a>
  &nbsp;·&nbsp;
  <a href="./docs/ACP.md">ACP</a>
  &nbsp;·&nbsp;
  <a href="./docs/EXTENSIONS.md">Extensions</a>
  &nbsp;·&nbsp;
  <a href="./docs/SPEC.md">Spec</a>
  &nbsp;·&nbsp;
  <a href="https://esengine.github.io/DeepSeek-Reasonix/">Upstream website</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/XF78rEME2D">Upstream community</a>
</p>

<p align="center">
  <a href="https://github.com/keeyangyy/DeepSeek-Reasonix/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/keeyangyy/DeepSeek-Reasonix/ci.yml?branch=wails-mine&style=flat-square&label=ci&labelColor=161b22&logo=githubactions&logoColor=white" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <a href="https://github.com/keeyangyy/DeepSeek-Reasonix/stargazers"><img src="https://img.shields.io/github/stars/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
</p>

<br/>

<p align="center"><strong>Open source · MIT · a single Go binary</strong></p>
<h3 align="center">A coding agent you can leave running.</h3>
<p align="center">One local engine, four ways in — terminal, desktop app, browser, or your editor over ACP. Plan mode, permissions, a workspace sandbox and per-turn checkpoints keep a long autonomous run something you can still read and undo.</p>

<div align="center">
  <video src="https://github.com/user-attachments/assets/ab2f3878-e224-4931-8254-060e7695cfb9" controls preload="metadata" width="560"></video>
</div>

<br/>

> **Independently maintained custom build**
>
> This fork branches from upstream DeepSeek-Reasonix v1.38.2 and keeps the Wails
> desktop app; it does not adopt Electron. Maintenance focuses on the Wails
> desktop layer (`desktop/`) and the shared Go core. The version line stays on
> 1.38.x and selectively picks up upstream 1.38 fixes; compatibility with later
> upstream releases is not guaranteed.
>
> This repository is not an official Reasonix release. Release channels, feature
> choices and issue handling may differ from upstream. Desktop builds cover
> Windows amd64 only and update from this repository's `wails-latest` channel,
> never from upstream.
>
> Upstream copyright notices are retained; the code remains under the MIT
> License. Upstream: <https://github.com/esengine/DeepSeek-Reasonix>

<br/>

## Features

- **Config-driven.** Providers, the agent, enabled tools, and plugins are all
  declared in `reasonix.toml`. No hardcoded models.
- **Multi-model & composable.** DeepSeek ships as a preset; any
  OpenAI-compatible endpoint is a config entry, not new code. Optionally run
  two models together (executor + planner) in separate, cache-stable sessions.
- **Plugin-driven.** MCP servers contribute tools, prompts, and resources;
  Extension Protocol v1 sidecars can also intercept runtime events, contribute
  Providers and structured UI, and ship versioned plugin packages.
- **Cache-aware context maintenance.** Startup injects a small stable environment
  summary, stale tool output is snipped/pruned before summary compaction, and the
  built-in tool schema contract is documented for regression review.
- **Zero-friction distribution.** `CGO_ENABLED=0` single binary; cross-compile
  to six targets with one command. The result is a fully self-contained static
  binary — nothing to install on the target machine beyond the binary itself.

## Install

This custom build offers two paths: download the Windows desktop installer from
this repository's Releases, or build from source. Upstream's npm, Homebrew and
website download channels do not apply to this build.

### Path A: Windows desktop

Download the latest installer from
[this repository's Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases):

| Platform | Package | Architecture |
| --- | --- | --- |
| Windows | Installer `Reasonix-windows-amd64-installer.exe` or portable `Reasonix-windows-amd64-portable.zip` | x64 |

The installer is not Authenticode-signed, so Windows SmartScreen may warn on
first launch. In-app updates are verified with this repository's minisign key.

### Path B: Build from source

Clone this repository first:

```sh
git clone https://github.com/keeyangyy/DeepSeek-Reasonix.git
cd DeepSeek-Reasonix
```

#### CLI

The CLI build requires **Go 1.26+**. The module pins a `toolchain` directive;
keep `GOTOOLCHAIN=auto` so Go downloads the pinned toolchain, or install it.

```sh
make build      # -> bin/reasonix(.exe)
make cross      # -> dist/ (darwin|linux|windows × amd64|arm64)
```

#### Desktop

The desktop app uses **Wails v2** (WebView2), not Electron. The build
additionally requires:

- **Node 24+ and pnpm 10** (`npm install -g pnpm@10`) for the frontend
- **Wails CLI** matching the shared `.wails-version` pin

```sh
make wails-install
cd desktop
wails build
```

See the [desktop build guide](desktop/README.md#prerequisites) for platform
webview dependencies and Linux build tags.

> The VS Code extension belongs to the upstream ecosystem and depends on the
> upstream CLI; this build does not ship a matching extension release.

## Quick start

### CLI / TUI

```sh
reasonix setup                      # configure a provider and model
reasonix                            # start an interactive session
reasonix run "implement the TODOs in main.go"
```

In an interactive session, run `/init` when you want Reasonix to create project
instructions.

### Desktop app

Download the installer from
[this repository's Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases),
install and launch Reasonix, then configure a provider and model in the app.

> This build and the official release share `%APPDATA%\reasonix` and the same
> single-instance lock by default. To run both side by side, set a separate
> `REASONIX_HOME` for one of them.

> Anonymous launch telemetry and crash reports still go to upstream
> `crash.reasonix.io` and can be disabled in settings. `reasonix upgrade` still
> points at the upstream release source and should not be used with this build.

For advanced CLI usage and configuration, see the **[CLI reference](./docs/CLI.md)**,
**[Guide](./docs/GUIDE.md)**, and
**[configuration paths](./docs/CONFIG_PATHS.md)**.

## Documentation

- **Getting started:** [Guide](./docs/GUIDE.md) · [CLI reference](./docs/CLI.md) ·
  [Configuration paths](./docs/CONFIG_PATHS.md) · [ACP editor integration](./docs/ACP.md)
- **Features & troubleshooting:** [Subagent profiles](./docs/SUBAGENT_PROFILES.md) ·
  [Context Engine v2](./docs/SESSION_MEMORY_RETRIEVAL.md) ·
  [Capability diagnostics](./docs/CAPABILITY_DIAGNOSTICS.md) ·
  [Recovery and updates](./docs/RECOVERY.md) · [Bot guide](./docs/BOT_GUIDE.md) ·
  [Checkpoints & rewind](./docs/CHECKPOINTS.md)
- **Engineering & migration:** [Spec](./docs/SPEC.md) ·
  [Task contracts & pause policy](./docs/TASK_CONTRACT.md) ·
  [Tool contract](./docs/TOOL_CONTRACT.md) · [Migrating from 0.x](./docs/MIGRATING.md)
- **Extension development:** [Extensions](./docs/EXTENSIONS.md) ·
  [Plugin packages and Manifest v1](./docs/PLUGIN_PACKAGES.md) ·
  [Extension Protocol](./docs/EXTENSION_PROTOCOL.md) ·
  [Go SDK and starter](./sdk/go/README.md)

## Acknowledgments

A small list of folks whose work has shaped Reasonix the most — the current top
20 contributors of the upstream project, by commit count. The full contributor
graph is on
[upstream GitHub](https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors?all=1).

<!-- reasonix-top-contributors:start -->
| Contributor | Contributor | Contributor | Contributor |
| --- | --- | --- | --- |
| [**SivanCola**](https://github.com/SivanCola) | [**esengine**](https://github.com/esengine) | [**ttmouse**](https://github.com/ttmouse) | [**lifu963**](https://github.com/lifu963) |
| **reasonix** | [**HUQIANTAO**](https://github.com/HUQIANTAO) | [**GTC2080**](https://github.com/GTC2080) | [**light-front-theory**](https://github.com/light-front-theory) |
| **merge-order-check** | [**Li-Charles-One**](https://github.com/Li-Charles-One) | [**eghrhegpe**](https://github.com/eghrhegpe) | **wufengfan** |
| [**CVEngineer66**](https://github.com/CVEngineer66) | [**dependabot\[bot\]**](https://github.com/apps/dependabot) | [**lanshi17**](https://github.com/lanshi17) | [**SuMuxi66**](https://github.com/SuMuxi66) |
| [**CnsMaple**](https://github.com/CnsMaple) | [**cyq1017**](https://github.com/cyq1017) | [**JesonChou**](https://github.com/JesonChou) | [**XTLine**](https://github.com/XTLine) |
<!-- reasonix-top-contributors:end -->

Special thanks to [**Bernardxu123**](https://github.com/Bernardxu123) for designing the project logo and intro video.

<p align="center">
  <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=esengine/DeepSeek-Reasonix&max=100&columns=12" alt="Contributors to esengine/DeepSeek-Reasonix" width="860"/>
  </a>
</p>

<br/>

---

<p align="center">
  <sub>MIT — see <a href="./LICENSE">LICENSE</a></sub>
  <br/>
  <sub>Built on the work of <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">esengine/DeepSeek-Reasonix</a>, independently maintained in this repository</sub>
</p>
