<p align="center">
  <img src="docs/logo-ghost-wave-effect.svg" alt="Reasonix" width="360"/>
</p>

<p align="center"><strong>个人分支线 · 已停止维护</strong></p>

<p align="center">
  <strong>简体中文</strong>
  &nbsp;·&nbsp;
  <a href="./README.en.md">English</a>
  &nbsp;·&nbsp;
  <a href="./docs/GUIDE.zh-CN.md">指南</a>
  &nbsp;·&nbsp;
  <a href="./docs/ACP.zh-CN.md">ACP</a>
  &nbsp;·&nbsp;
  <a href="./docs/EXTENSIONS.zh-CN.md">扩展开发</a>
  &nbsp;·&nbsp;
  <a href="./docs/SPEC.zh-CN.md">规格</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
</p>

---

> [!WARNING]
> **本仓库已停止维护。** 代码冻结，不再发布新版本、修复问题或处理 issue。
>
> 本仓库是一条个人分支线：从上游 DeepSeek-Reasonix v1.38.2 分出，曾并行维护 Wails（1.x）与 Studio（2.x）两条线，后期以 Wails 线为主。两条线已分别迁出，后续维护见：
>
> - **[reasonix-wails](https://github.com/keeyangyy/reasonix-wails)**：接续 Wails 线，Windows 单 exe、轻量、易用。
> - **reasonix-studio**：接续 2.x 线，Electron 桌面、功能全面（仓库筹备中）。
>
> 上游 [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 已于 2026-11-12 归档，最终版本 v2.61.0。

## 项目介绍

本仓库是 Reasonix 的个人分支线，不是官方发行版。它从上游 v1.38.2 分出，保留 Go + Wails 桌面实现，并在此基础上独立迭代；发布渠道、功能取舍和问题处理均与上游不同。

分支线的历史大致分为三段：

- **并行期**：同时维护 Wails（`wails-mine`，1.x）、Studio（`studio-mine`，2.x Electron）和更早的 Electron 线（`main-v2-mine`）。
- **收敛期**：上游桌面端转向 Electron 后，本线以 Wails 为主，选择性吸收上游 1.x 的修复。
- **停止维护**：Wails 线最终版本为 **v1.38.55**（2026-11-04），Studio 线最终版本为 **v2.57.0**（2026-11-01）。后续开发分别由 reasonix-wails 与 reasonix-studio 接续。

原项目的版权声明、MIT 许可与贡献者署名均予保留。

## 特性

- **配置驱动**：provider、agent、启用的工具、插件全部在 `reasonix.toml` 中声明，内核无硬编码模型。
- **多模型 · 可组合**：DeepSeek 作为预设内置；任何 OpenAI 兼容端点都只是一条配置。可选让两个模型协同（执行器 + 规划器），各自独立、缓存稳定的 session。
- **插件驱动**：MCP server 提供工具、提示词和资源；Extension Protocol v1 Sidecar 还可以拦截运行时事件、提供 Provider 与结构化 UI，并通过版本化插件包分发。
- **缓存友好的上下文维护**：启动时注入稳定的环境摘要；旧工具输出会先 snip/prune，再进入摘要 compaction；内置工具 schema 合约有文档和回归测试保护。
- **零摩擦分发**：`CGO_ENABLED=0` 单二进制；一条命令交叉编译到六个目标平台。产物是完全自包含的静态二进制。

## 下载与构建

本仓库的 [Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases) 保留历史版本，**不再更新**。Wails 线最终版为 `v1.38.55`；新用户请使用 [reasonix-wails](https://github.com/keeyangyy/reasonix-wails)。

### 历史安装包

| 平台 | 安装包 | 架构 |
| --- | --- | --- |
| Windows | 安装器 `Reasonix-windows-amd64-installer.exe` 或便携包 `Reasonix-windows-amd64-portable.zip` | x64 |

安装包未做 Authenticode 签名，首次运行可能触发 Windows SmartScreen 提示；应用内更新包使用本仓库的 minisign 公钥校验。

### 从源码构建

```sh
git clone https://github.com/keeyangyy/DeepSeek-Reasonix.git
cd DeepSeek-Reasonix
```

#### CLI

CLI 构建需要 **Go 1.26+**。模块固定了 `toolchain` 指令；保持 `GOTOOLCHAIN=auto` 让 Go 自动下载固定的工具链，或自行安装。

```sh
make build      # -> bin/reasonix(.exe)
make cross      # -> dist/（darwin|linux|windows × amd64|arm64）
```

#### 桌面端

桌面端基于 **Wails v2**（WebView2），不使用 Electron。构建额外需要：

- **Node 24+ 和 pnpm 10**（`npm install -g pnpm@10`）用于前端
- **Wails CLI**，与共享的 `.wails-version` 固定版本一致

```sh
make wails-install
cd desktop
wails build
```

平台相关的 WebView 依赖和 Linux 构建标签见[桌面端构建指南](desktop/README.md#prerequisites)。

> VS Code 扩展属于上游生态，依赖上游 CLI；本版本不提供该扩展的配套发布。

## 快速开始

以下命令适用于本仓库的历史版本。

### CLI / TUI

```sh
reasonix setup                      # 配置 provider 和模型
reasonix                            # 启动交互式会话
reasonix run "把 main.go 里的 TODO 实现掉"
```

需要项目指令时，可在交互式会话中运行 `/init`。

### 桌面端

安装并启动 Reasonix，然后在应用内配置 provider 和模型即可使用。

> 本版本与官方版默认共用 `%APPDATA%\reasonix` 数据目录和单实例锁。如需两者共存，请为其中一个设置独立的 `REASONIX_HOME`。

> 历史版本可能仍保留上游的匿名启动统计与崩溃报告配置，可在设置中关闭。`reasonix upgrade` 指向上游 release 源，不建议在本版本中使用。

## 文档

- **开始使用：** [指南](./docs/GUIDE.zh-CN.md) · [CLI 命令参考](./docs/CLI.zh-CN.md) · [配置路径](./docs/CONFIG_PATHS.zh-CN.md) · [ACP 编辑器接入](./docs/ACP.zh-CN.md)
- **功能与排障：** [子智能体 Profile](./docs/SUBAGENT_PROFILES.zh-CN.md) · [Context Engine v2](./docs/SESSION_MEMORY_RETRIEVAL.zh-CN.md) · [能力诊断](./docs/CAPABILITY_DIAGNOSTICS.zh-CN.md) · [恢复与安全模式](./docs/RECOVERY.zh-CN.md) · [机器人使用指南](./docs/BOT_GUIDE.zh-CN.md) · [Checkpoints 与 rewind](./docs/CHECKPOINTS.zh-CN.md)
- **工程与迁移：** [规格](./docs/SPEC.zh-CN.md) · [任务合约与暂停策略](./docs/TASK_CONTRACT.zh-CN.md) · [工具合约](./docs/TOOL_CONTRACT.zh-CN.md) · [从 0.x 迁移](./docs/MIGRATING.zh-CN.md)
- **扩展开发：** [扩展概览](./docs/EXTENSIONS.zh-CN.md) · [插件包与 Manifest v1](./docs/PLUGIN_PACKAGES.zh-CN.md) · [Extension Protocol](./docs/EXTENSION_PROTOCOL.zh-CN.md) · [Go SDK 与 starter](./sdk/go/README.md)

## 致谢

本项目基于 [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的 1.x 代码，遵循 MIT 许可证。感谢原作者与所有上游贡献者；完整名单见[上游贡献者](https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors?all=1)。

项目 logo 由 [Bernardxu123](https://github.com/Bernardxu123) 设计。

---

<p align="center">
  <sub>MIT —— 见 <a href="./LICENSE">LICENSE</a></sub>
</p>
