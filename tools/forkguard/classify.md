---
owner: @esengine
backup: @SivanCola
status: active
reviewed: 2026-10-16
---

# 上游同步判读（forkguard classify）

云端判读环节的提示词与判定表。

输入是 [customizations.json](customizations.json) 与 forkguard 的报告（命中点、上游新增文件、守护测试），以及上游该区间的 diff。

输出必须符合 [schema.json](schema.json)。

判定表是"功能性冲突"的唯一口径。改口径要改项目库里的决策文档 `docs/DeepSeek-Reasonix/decisions/2026-10-16-上游自动同步与发版.md`（不在本仓库内）。

## 判定表

### 机械类（`class: mechanical`，可自动通过）

- 格式化、import 顺序、注释与文档文字
- 行号位移、代码块搬家、同文件内的符号重命名跟随
- 生成物：lock、fixture、快照、i18n 键位置
- 上游改了同一文件里**与我们挂载点无关**的位置

### 功能性类（`class: functional`，必须停）

- **反向吸收**：上游自行实现了我们某个主题的能力 → `decision: upstream-absorbed`
- 上游改了我们挂载点的**符号 / 签名 / 语义**（我们带的字段、钩子、路由、事件码、开关默认值等）
- 配置默认值或语义变化（`[memory]` 开关、更新目录、写入策略等）
- 数据 schema / 版本、公共契约、权限与安全相关
- 不可绕过的接口变更（我方实现编不过）

## 通道

判读走 REST：`POST https://models.github.ai/inference/chat/completions`，带 `Authorization: Bearer $GITHUB_TOKEN`，workflow 侧声明 `models: read`。官方 `actions/ai-inference@v1` 虽可用，但解析回复有 bug（模型返回纯文本时报 `Cannot use 'in' operator to search for 'choices' in OK`），不要用它。

## 流程（顺序不可颠倒）

1. **先跑命中主题的守护测试**（报告里的 `guards`）：全绿 → `verdict: proceed`，不必再判其余。
2. 测试红、或该主题没有守护测试 → 按判定表逐个 hit 定级。
3. 任一 hit 为 functional → `verdict: hold`；全部 mechanical → `proceed`。
4. **不确定一律 hold**（默认保守）。
5. 上游新增文件（`upstream_added`）单独看一遍：若其中有与我们 `added` 同主题、同目录或同名的实现，按反向吸收处理（`hold`）。

## 输出要求

- 必须符合 [schema.json](schema.json)；不合法一律按 `hold` 处理。
- 每个 hit 都要给 `evidence`：引用上游 diff 的具体 hunk，或我们主题笔记的具体条目。
- **反方复核**：给出结论后，再写 `counterexample`——"若此结论错，最可能错在哪"。若该反例成立，改判 `hold`。
- `summary` 一句话，写给人看（会出现在通知里）。