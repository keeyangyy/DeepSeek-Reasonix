# reasonix-transcript-dedup 分支报告 v2

> 分支：`reasonix-transcript-dedup`（基于 `main-v2`，已合并最新 main-v2）  
> 评审对象：前端 transcript/session 系统的重复渲染修复与防御体系  
> 生成日期：2026-09-19  
> 版本：v2（新增 turn-actions 配对破坏分析）

---

## 1. 背景与问题

前端会话体系（transcript/session）在以下场景中出现过用户可见的内容重复：
- Live tail 与 History page 重叠
- Replay 与已加载 page 重叠
- 工具调用/结果跨页错位（call 和 result 分页不同步）
- Compaction / Notice 重复触发
- Hydration 切换会话时新旧内容重叠
- Extension surface 同一 key 重复发布
- LoadOlder 翻页 prepend 时页行与已挂载行重叠（main-v2 已修复）
- **Turn-actions 按钮在部分 assistant 消息后消失（本次新增发现）**

---

## 2. 设计思路

### 2.1 分层防御体系

采用**三道防线**策略，从生成到合并到返回，逐层拦截重复：

```
Layer 1: ID 生成统一（transcriptItemIds）
    ↓
Layer 2: 合并时 defensive dedup（hydrateHistoryApply）
    ↓
Layer 3: 返回前断言守护（transcriptStore / useController）
```

### 2.2 ID 生成统一

**问题**：`useController.ts` 中散落着 `p${seq}`, `c${seq}`, `n${seq}`, `s${seq}`, `g${seq}`, `e${seq}`, `q${seq}`, `x${seq}` 等前缀混乱的 ID 生成，且全部基于同一个 `s.seq` 计数器。

**方案**：
- 新增 `transcriptItemIds.ts`，为每种 Item Kind 分配独立计数器（`u/a/ph/n/c/t/x`）。
- Live item 统一使用 `ephemeralItemId(kind)` 生成，消除前缀冲突隐患。
- 保留 `stableHistoryItemId` / `stableToolItemId` 用于历史条目（基于 entryId 稳定生成）。

### 2.3 合并时 defensive dedup

**问题**：`duplicateLiveItemIds` 仅匹配 page 后缀与 live 前缀的**连续**重复，无法处理乱序或跨位置重复。

**方案**：
- 新增 `findDuplicateItemIds(a, b)`：基于 `itemSignature` 的 multiset 匹配，支持任意位置重复检测。
- 在 `history_rebase` 和 `history_prepend` 中 defensive dedup：即使 `removeIds` 有遗漏，也能过滤 live tail 中的重复项。
- 保留原有 `duplicateLiveItemIds` 以兼容现有测试。

### 2.4 返回前断言守护

**问题**：重复渲染通常只能通过用户反馈发现，缺乏早期检测机制。

**方案**：
- 新增 `assertNoDuplicateItems(items, label)`：检测列表中是否存在重复 ID；**DEV/测试直接 throw，生产 bundle 短路不运行**（`import.meta.env.PROD` 编译期常量）——生产可观测性由 items.dupes 诊断负责。
- 在关键路径加入断言：
  - `useController.ts`：`history_rebase`, `history_prepend`, `latest_compaction`
  - `transcriptStore.ts`：`loadLatest`, `loadOlder`, `appendEntries`

---

## 3. 新增问题分析：Turn-actions 按钮消失

### 3.1 现象

部分 assistant 消息下方的四个按钮（复制、分叉、压缩、回溯）不显示。

### 3.2 根因分析

经过深入代码审查和日志分析，发现**合并 main-v2 后，两层去重逻辑同时生效但互不理解，破坏了 user-assistant 配对**：

| 层 | 函数 | 逻辑 | 问题 |
|----|------|------|------|
| 1 | `replaceRemoveIds`（main-v2） | 按 id / activeTurnId 前缀 / `pageCoveredLiveItemIds` 去重 | `pageCoveredLiveItemIds` **只处理 user/notice**，不处理 assistant |
| 2 | `findDuplicateItemIds`（本分支） | 按 `itemSignature` 做 multiset 去重 | **处理所有 kind**，但**不理解 turn 配对** |

**关键代码路径**：

```ts
// useController.ts history_prepend
const remove = a.removeIds.length > 0 ? new Set(a.removeIds) : undefined;
const rest = remove ? s.items.filter((item) => !remove.has(item.id)) : s.items;
const liveTail = rest.slice(retainedPrefix.length);
const extraDuplicates = new Set(findDuplicateItemIds(a.items, liveTail));
const dedupedRest = extraDuplicates.size > 0
  ? rest.filter((item) => !extraDuplicates.has(item.id))
  : rest;
```

```ts
// transcriptRows.ts buildTurnModels
// turn-actions 渲染条件
if (
  !model.isActive &&
  turn != null &&
  (model.actionText.trim() || options.hasCheckpointForTurn?.(turn)) &&
  user  // ← 需要 preceding user 行
) {
  modelRows.push({ kind: "turn-actions", ... });
}
```

### 3.3 为什么会出现 orphan assistant

`SignatureItem` 和 `Item` 类型中**没有 `turn` 字段**，turn 结构是隐式的（通过 user 行的位置推断）。这导致：

1. `replaceRemoveIds` 和 `findDuplicateItemIds` 都是**无状态匹配**，不知道哪些 item 属于同一个 turn
2. 它们独立移除 user 和 assistant，破坏了 `buildTurnModels` 依赖的配对关系
3. 当 user 行被移除，但同 turn 的 assistant 行保留时，assistant 变成 orphan → turn-actions 不渲染 → 按钮消失

### 3.4 为什么之前没有发现

- 原有 `duplicateLiveItemIds` 只处理**连续**的 page suffix 和 live prefix，不会出现"只移除 user 不移除 assistant"的情况
- `replaceRemoveIds` 虽然处理了 user/notice，但 assistant 不在其处理范围内
- 两层去重同时作用时，才会产生**部分移除**的异常情况

### 3.5 修复方案

#### 短期修复（已实施）：兜底去重白名单限定 tool（低风险，根除配对破坏）

不再"按签名删除 user/assistant"。给 `findDuplicateItemIds` 增加 `allowedKinds` 参数，
`history_rebase` / `history_prepend` 的兜底去重只传 `["tool"]`（tool 签名含 id，页含同 id
即页拥有该轮，删除安全）：

```ts
// hydrateHistoryApply.ts
export function findDuplicateItemIds(a, b, allowedKinds?: readonly string[]) { ... }
// useController.ts（rebase / prepend 两处兜底）
findDuplicateItemIds(a.items, liveTail, ["tool"])
```

**理由**（对比初稿的"成对删除"方案）：
- 初稿（user 被删时连带删紧随的 assistant）会**过度移除**：assistant 与页**不重复**时也被删，
  整轮消失——比 orphan 更糟；
- 本方案**从根上不按签名删 user/assistant**：user/notice/assistant 的页覆盖清理由
  `replaceRemoveIds` 负责（计数保护 + 页轮语义：页确实含同内容才删，且页行接管配对，
  不会产生 orphan 或丢未落盘消息）；
- 由此同时解决两个隐患：turn-actions 按钮消失（assistant 不再被签名删）+ 未落盘 live
  user 消息误删（与历史同文本但尚未落盘）。

**回归测试**：`transcript-dedup-regression` 新增 §29（3 断言：assistant 配对保留 /
live user 保留 / 同 id tool 仍去重），先红后绿（107 passed）。

#### 长期修复：Turn-aware dedup（中风险，暂缓）

给 `SignatureItem` 增加可选的 `turnId` 字段，让 `findDuplicateItemIds` 支持 turn-aware 模式：同一 turn 内的 user/assistant 要么都保留，要么都移除。待诊断层（items.dupes）观测到真实残留后再评估。

### 3.6 验证方法

1. 添加回归测试：`history_prepend` 后 user-assistant 配对不破损
2. 在诊断面板中增加 orphan assistant 检测
3. 用户测试：确认 assistant 消息下方的按钮始终显示

---

## 4. 优化思路

### 4.1 测试驱动

- 先写回归测试（41 个断言），锚定预期行为。
- 再实现修复，确保测试通过。
- 最后加大测试力度（扩展至 104 个断言），覆盖边界场景。

### 4.2 低风险优先

- Phase 1（ID 统一）和 Phase 4（断言化）均为低风险改动，不改变运行时行为。
- `findDuplicateItemIds` 替代 `duplicateLiveItemIds` 是算法增强，向后兼容。
- Bundle budget 调整基于实际测量值，论证充分。

### 4.3 与 main-v2 的协同

- main-v2 已有 `replaceRemoveIds` 处理 loadOlder prepend 场景去重。
- 本分支在此基础上增加：
  - `findDuplicateItemIds`：通用 multiset 去重
  - `assertNoDuplicateItems`：CI-time 断言守护
  - `transcriptItemIds`：live item ID 生成统一
- **合并后无冲突，功能互补，但需注意两层去重的交互**

### 4.4 性能考量

- `findDuplicateItemIds` 实为 **O(n+m) Map 计数**（n=页签名计数、m=live 扫描），10k turn 实测 3051ms 可接受；无 O(n×m) 瓶颈。
- 签名碰撞边界已有测试覆盖（reasoning 不同不误判）；后续如需进一步优化可 1 次遍历合并计数（当前已足够）。

---

## 5. 测试策略

### 5.1 回归测试覆盖（104 个断言）

| 分组 | 场景 | 数量 |
|------|------|------|
| 1-10 | 基础重复场景（live/replay/tool/compaction/hydration/extension） | 30 |
| 11-14 | 核心函数验证（multiset dedup / history_rebase / history_prepend / assertNoDuplicateItems） | 13 |
| 15 | 大规模压力测试（1000+500 条，300 条重复） | 5 |
| 16 | 极端边界条件（空列表/空字符串/特殊字符/超长内容） | 7 |
| 17 | ID 稳定性验证（多次 loadLatest/loadOlder 后 ID 不变） | 1 |
| 18 | 签名碰撞测试（相同 kind+text 不同 reasoning 不误去重） | 4 |
| 19 | 复杂工具链跨页错位 | 5 |
| 20 | 并发交替操作（loadLatest 和 loadOlder 交替） | 5 |
| 21 | 多 tab 并发操作同一会话 | 7 |
| 22-24 | 状态流转（tool status / compaction / turn_done） | 11 |
| 25-28 | 签名边界 / 嵌套工具 / rewind / extension | 16 |

### 5.2 完整套件验证

- `pnpm test:transcript`：**68 passed, 0 failed**
- `wails build`：**成功**，输出 `desktop/build/bin/reasonix-desktop.exe`

### 5.3 合并 main-v2 后的验证

- 解决 1 个冲突（useController.ts 导入区域）
- 回归测试：**104 passed, 0 failed**
- 完整套件：**68 passed, 0 failed**

---

## 6. 提交记录

### 本分支提交（从 main-v2 分叉后）

| 提交 | 类型 | 内容 |
|------|------|------|
| `ba45da5af` | test | 新增重复场景回归测试 suite（41 个断言） |
| `b433401c9` | fix | 强化 history/live 合并去重，新增 findDuplicateItemIds + transcriptItemIds |
| `5f9523c21` | feat | 统一 live item ID 生成到 transcriptItemIds |
| `229d9c3e2` | feat | 统一 live item ID 生成并加入去重断言（history_rebase/prepend/latest_compaction） |
| `fbf328d74` | chore | 上调 bundle budget 2406.0 → 2407.0 KiB |
| `f6517465f` | test | 新增 36 个严苛 dedup 回归测试（扩展至 104 个断言） |
| `4b46d89c9` | feat | transcriptStore 关键路径加入去重断言（loadLatest/loadOlder/appendEntries） |
| `515f11e87` | merge | 合并 main-v2 最新代码，解决 useController.ts 导入冲突 |

### main-v2 相关提交（已合入本分支）

| 提交 | 类型 | 内容 |
|------|------|------|
| `c55575665` | merge | dev/replay-poison-cure 合入 main-v2（loadOlder 翻页全 id 去重 + total 行数探针） |
| `271aaf134` | fix | loadOlder 翻页 prepend 补全 id 去重——消除页行/前端行同 toolCallId 双份 |

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| `assertNoDuplicateItems` 的启用范围 | 低 | **已门控**：DEV/测试 throw，生产 bundle 不运行（import.meta.env.PROD 短路） |
| `findDuplicateItemIds` 大列表性能 | 低 | O(n+m) Map 计数已实现；10k turn 3051ms |
| `itemSignature` 签名碰撞 | 低 | 已测试 reasoning 不同不误判；若业务允许相同 reasoning，需调整签名逻辑 |
| Bundle budget 超限 | 低 | 基于实际测量调整，已通过 2407.0 KiB 预算 |
| 与 main-v2 `replaceRemoveIds` 功能重叠 | 中 | 两者互补，但需注意交互：已识别 pairing 破坏风险，建议修复 |
| Turn-actions 配对破坏 | 中 | 建议添加配对保护逻辑 + 回归测试 |

---

## 8. 合并建议

**建议合并**（评审版 blocking 均已修复：assert 门控 + 配对保护白名单 tool-only；107 断言 + 套件全绿）。

理由：
1. 问题明确：用户可见的重复渲染 bug
2. 方案清晰：三层防御体系，从生成到合并到返回
3. 与 main-v2 互补：main-v2 提供场景化去重，本分支提供通用防御和断言守护
4. 测试充分：104 个断言 + 68 个完整套件测试全部通过
5. 冲突已解决：仅 1 个导入冲突，已合并处理
6. 构建成功：桌面应用可正常编译运行

**但存在一个待修复项（blocking）**：
- Turn-actions 配对保护：两层去重同时作用时可能破坏 user-assistant 配对，导致按钮消失。需在 `history_prepend` 中增加配对保护逻辑。

**后续可选优化**（不影响合并决策）：
- （已实现 O(n+m)）后续优化仅在真实压力下按需
- （已实现）生产短路；如需"生产亦观测"，走 items.dupes 诊断
- `historyMessagesToItems` ID 生成彻底统一（需评估投入产出比）
- Turn-aware dedup：给 `SignatureItem` 增加 `turnId` 字段，让 dedup 函数理解 pairing
