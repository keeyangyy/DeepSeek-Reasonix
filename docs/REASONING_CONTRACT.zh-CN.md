# 适配器拥有的思考选项

每个协议适配器随工厂注册纯函数 `ReasoningForConfig`，返回当前连接和模型可用的
选项、顺序、显示名称及默认值。核心不定义统一的力度枚举。已创建客户端通过
`ReasoningProvider` 返回独立的能力副本，外部修改不会改变客户端行为。

配置、桌面菜单、CLI 补全、本地模型目录和请求校验使用同一套声明。查询能力前必须
先解析模型级覆盖。扩展供应商的选项由其 `Efforts` 声明提供，在 sidecar 请求前校验。

显式选择必须与声明的 ID 完全一致。不支持的值在网络请求前返回
`UNSUPPORTED_REASONING_EFFORT`，不再转换到相邻档位。非法能力声明也会报错。
只有开关能力的协议，不能通过填写 `supported_efforts` 虚构低、中、高能力。

`auto` 保留原有“清除覆盖、使用默认”的界面与 CLI 含义，不等于自适应思考。
请求级 override 使用空字符串表示继承，而不是发送字面值 `auto`。保留旧配置加载时
对大小写及已退役 `off` 的兼容处理；已有合法 ID 和 TOML 字段名不变。未声明自定义
档位时，已保存的 DeepSeek `medium`、`xhigh` 沿用历史请求值 `high`，不重写配置。
新的显式选择和请求覆盖仍拒绝未声明的别名。其他非法值明确报错；非法默认值保留供校验，不替换为第一档。

| 边界 | 兼容行为 |
| --- | --- |
| Provider TOML | 字段与合法 ID 不变，不自动重写文件 |
| 桌面 `EffortInfo.options` | 新增可选元数据，同时保留旧 `levels` |
| 新前端连接旧后端 | 回退读取 `levels` |
| 远程模型目录 | 继续使用原有 `Efforts` 声明 |
| 模型历史 | 不改提示词、工具定义或历史思考内容 |

默认请求保留原有序列化。主动修改力度仍可能影响服务端缓存；契约本身不增加提示词
内容。实验性 governor 在自动使用 low 前检查适配器声明。本次不引入自动跨模型
力度迁移，也不移植 Harness 的请求日志架构。

参考 [DeepSeek Harness 设计](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/.agents/notes/implemented/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)
独立实现，未复制上游代码。
## 纯空白 reasoning 存为空串

Provider 在并未真正推理的回合里，可能返回只含空白的 reasoning 块。这些是真实的
`reasoning_content` 值——某份 820 行 transcript 中，纯空白块有 559 条，有内容的仅 48 条——
原样落盘会让每个读取方对「空」的判断不一致：桌面端折叠头把它们算作思考段，而渲染层
trim 之后什么都不显示。

`normalizeReasoning`（`internal/agent/run_loop.go`）在写入边界解决这件事：`strings.TrimSpace`
结果为空的值存为 `""`，于是 history、投影与 replay 看到的是同一个结果。

这条规则刻意收窄。任何有实际文字的块都保留原有字节，包括其前后的空白——保留思考的协议要求
返回内容完整不变。归一化不在读取时进行，因此已落盘的会话保持写入时的形态。

由于前端折叠过滤以 reasoning 是否存在为判据（`it.reasoning.trim() !== ""`），存为空串正是
纯空白回合不会虚增思考段数的原因。
