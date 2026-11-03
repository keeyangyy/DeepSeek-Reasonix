<p align="center">
  <img src="docs/logo-ghost-wave-effect.svg" alt="Reasonix" width="360"/>
</p>

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <strong>简体中文</strong>
  &nbsp;·&nbsp;
  <a href="./docs/GUIDE.zh-CN.md">指南</a>
  &nbsp;·&nbsp;
  <a href="./docs/ACP.zh-CN.md">ACP</a>
  &nbsp;·&nbsp;
  <a href="./docs/EXTENSIONS.zh-CN.md">扩展开发</a>
  &nbsp;·&nbsp;
  <a href="./docs/SPEC.zh-CN.md">规格</a>
  &nbsp;·&nbsp;
  <a href="https://esengine.github.io/DeepSeek-Reasonix/">上游官网</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/XF78rEME2D">上游社区</a>
</p>

<p align="center">
  <a href="https://github.com/keeyangyy/DeepSeek-Reasonix/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/keeyangyy/DeepSeek-Reasonix/ci.yml?branch=wails-mine&style=flat-square&label=ci&labelColor=161b22&logo=githubactions&logoColor=white" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <a href="https://github.com/keeyangyy/DeepSeek-Reasonix/stargazers"><img src="https://img.shields.io/github/stars/keeyangyy/DeepSeek-Reasonix.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
</p>

<br/>

<p align="center"><strong>开源 · MIT · 单个 Go 二进制</strong></p>
<h3 align="center">可以一直开着跑的编码 Agent。</h3>
<p align="center">一套本地引擎,四个入口——终端、桌面端、浏览器,或通过 ACP 接入你的编辑器。计划模式、权限、工作区沙箱与逐轮 checkpoint,让长时间自治运行始终可读、可撤销。</p>

<div align="center">
  <video src="https://github.com/user-attachments/assets/ab2f3878-e224-4931-8254-060e7695cfb9" controls preload="metadata" width="560"></video>
</div>

<br/>

> **独立维护的定制版本**
>
> 本版本从上游 DeepSeek-Reasonix v1.38.2 分出，保留 Wails 桌面端，未引入 Electron。
> 当前主要维护 Wails 桌面端（`desktop/`）及其共享 Go 核心，版本号继续沿用 1.38.x 序列，
> 并选择性吸收上游 1.38 线的修复；不承诺跟随上游后续版本，也不保证与官方版互相兼容。
>
> 本仓库不是 Reasonix 官方发行版本，发布渠道、功能取舍和问题处理均可能与上游不同。
> 桌面端仅发布 Windows amd64；更新从本仓库的 `wails-latest` 通道获取，不会自动更新为上游版本。
>
> 原项目及贡献者的版权声明予以保留，代码遵循 MIT 许可证。上游项目：
> <https://github.com/esengine/DeepSeek-Reasonix>

<br/>

## 特性

- **配置驱动**：provider、agent、启用的工具、插件全部在 `reasonix.toml` 中声明，
  内核无硬编码模型。
- **多模型 · 可组合**：DeepSeek 作为预设内置；任何 OpenAI 兼容
  端点都只是一条配置。可选让两个模型协同（执行器 + 规划器），各自独立、缓存稳定的 session。
- **插件驱动**：MCP server 提供工具、提示词和资源；Extension Protocol v1
  Sidecar 还可以拦截运行时事件、提供 Provider 与结构化 UI，并通过版本化插件包分发。
- **缓存友好的上下文维护**：启动时注入稳定的环境摘要；旧工具输出会先 snip/prune，
  再进入摘要 compaction；内置工具 schema 合约有文档和回归测试保护。
- **零摩擦分发**：`CGO_ENABLED=0` 单二进制；一条命令交叉编译到六个目标平台。
  产物是完全自包含的静态二进制——目标机器上除二进制本身外无需安装任何东西。

## 安装

本定制版提供两条安装路径：直接下载本仓库发布的 Windows 桌面安装包，或从源码构建。
上游的 npm、Homebrew 和官网下载渠道不适用于本版本。

### 路径 A：Windows 桌面端

前往[本仓库 Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases)下载最新安装包：

| 平台 | 安装包 | 架构 |
| --- | --- | --- |
| Windows | 安装器 `Reasonix-windows-amd64-installer.exe` 或便携包 `Reasonix-windows-amd64-portable.zip` | x64 |

安装包未做 Authenticode 签名，首次运行可能触发 Windows SmartScreen 提示；
应用内更新包使用本仓库的 minisign 公钥校验。

### 路径 B：从源码构建

先克隆本仓库：

```sh
git clone https://github.com/keeyangyy/DeepSeek-Reasonix.git
cd DeepSeek-Reasonix
```

#### CLI

CLI 构建需要 **Go 1.26+**。模块固定了 `toolchain` 指令；
保持 `GOTOOLCHAIN=auto` 让 Go 自动下载固定的工具链，或自行安装。

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

平台相关的 WebView 依赖和 Linux 构建标签见
[桌面端构建指南](desktop/README.md#prerequisites)。

> VS Code 扩展属于上游生态，依赖上游 CLI；本版本不提供该扩展的配套发布。

## 快速开始

### CLI / TUI

```sh
reasonix setup                      # 配置 provider 和模型
reasonix                            # 启动交互式会话
reasonix run "把 main.go 里的 TODO 实现掉"
```

需要项目指令时，可在交互式会话中运行 `/init`。

### 桌面端

从[本仓库 Releases](https://github.com/keeyangyy/DeepSeek-Reasonix/releases)下载对应安装包，
安装并启动 Reasonix，然后在应用内配置 provider 和模型即可使用。

> 本版本与官方版默认共用 `%APPDATA%\reasonix` 数据目录和单实例锁。如需两者共存，
> 请为其中一个设置独立的 `REASONIX_HOME`，避免配置、会话和单实例互相干扰。

> 桌面端匿名启动统计与崩溃报告目前仍发送到上游 `crash.reasonix.io`，可在设置中关闭。
> CLI 的 `reasonix upgrade` 目前仍指向上游 release 源，不建议在本版本中使用。

CLI 进阶用法和详细配置见 **[CLI 命令参考](./docs/CLI.zh-CN.md)**、
**[指南](./docs/GUIDE.zh-CN.md)** 和
**[配置路径](./docs/CONFIG_PATHS.zh-CN.md)**。

## 文档

- **开始使用：** [指南](./docs/GUIDE.zh-CN.md) ·
  [CLI 命令参考](./docs/CLI.zh-CN.md) · [配置路径](./docs/CONFIG_PATHS.zh-CN.md) ·
  [ACP 编辑器接入](./docs/ACP.zh-CN.md)
- **功能与排障：** [子智能体 Profile](./docs/SUBAGENT_PROFILES.zh-CN.md) ·
  [Context Engine v2](./docs/SESSION_MEMORY_RETRIEVAL.zh-CN.md) ·
  [能力诊断](./docs/CAPABILITY_DIAGNOSTICS.zh-CN.md) ·
  [恢复与安全模式](./docs/RECOVERY.zh-CN.md) ·
  [机器人使用指南](./docs/BOT_GUIDE.zh-CN.md) ·
  [Checkpoints 与 rewind](./docs/CHECKPOINTS.zh-CN.md)
- **工程与迁移：** [规格](./docs/SPEC.zh-CN.md) ·
  [任务合约与暂停策略](./docs/TASK_CONTRACT.zh-CN.md) ·
  [工具合约](./docs/TOOL_CONTRACT.zh-CN.md) ·
  [从 0.x 迁移](./docs/MIGRATING.zh-CN.md)
- **扩展开发：** [扩展概览](./docs/EXTENSIONS.zh-CN.md) ·
  [插件包与 Manifest v1](./docs/PLUGIN_PACKAGES.zh-CN.md) ·
  [Extension Protocol](./docs/EXTENSION_PROTOCOL.zh-CN.md) ·
  [Go SDK 与 starter](./sdk/go/README.md)

## 致谢

下面这些朋友的工作塑造了 Reasonix 今天的样子 —— 以下按 commit 数统计的是上游项目的前 20 名贡献者。
完整贡献者列表见
[上游 GitHub](https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors?all=1)。

<!-- reasonix-top-contributors:start -->
| Contributor | Contributor | Contributor | Contributor |
| --- | --- | --- | --- |
| [**SivanCola**](https://github.com/SivanCola) | [**esengine**](https://github.com/esengine) | [**ttmouse**](https://github.com/ttmouse) | [**lifu963**](https://github.com/lifu963) |
| **reasonix** | [**HUQIANTAO**](https://github.com/HUQIANTAO) | [**GTC2080**](https://github.com/GTC2080) | [**light-front-theory**](https://github.com/light-front-theory) |
| **merge-order-check** | [**Li-Charles-One**](https://github.com/Li-Charles-One) | [**eghrhegpe**](https://github.com/eghrhegpe) | **wufengfan** |
| [**CVEngineer66**](https://github.com/CVEngineer66) | [**dependabot\[bot\]**](https://github.com/apps/dependabot) | [**lanshi17**](https://github.com/lanshi17) | [**SuMuxi66**](https://github.com/SuMuxi66) |
| [**CnsMaple**](https://github.com/CnsMaple) | [**cyq1017**](https://github.com/cyq1017) | [**JesonChou**](https://github.com/JesonChou) | [**XTLine**](https://github.com/XTLine) |
<!-- reasonix-top-contributors:end -->

特别感谢 [**Bernardxu123**](https://github.com/Bernardxu123) 设计的项目 logo 和开场视频。

<p align="center">
  <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=esengine/DeepSeek-Reasonix&max=100&columns=12" alt="esengine/DeepSeek-Reasonix 贡献者" width="860"/>
  </a>
</p>

<br/>

---

<p align="center">
  <sub>MIT —— 见 <a href="./LICENSE">LICENSE</a></sub>
  <br/>
  <sub>基于 <a href="https://github.com/esengine/DeepSeek-Reasonix/graphs/contributors">esengine/DeepSeek-Reasonix</a> 的成果，由本仓库独立维护</sub>
</p>
