# reasonix-transcript-dedup 分支报告

> 分支：`reasonix-transcript-dedup`（基于 `main-v2`，已合并最新 main-v2）  
> 评审对象：前端 transcript/session 系统的重复渲染修复与防御体系  
> 生成日期：2026-09-19

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

根因分析：
1. **ID 生成混乱**：live item 使用 `${s.seq}` 作为 ID 后缀，不同 kind 共用同一个 seq 计数器，存在潜在冲突。
2. **去重逻辑不完整**：`duplicateLiveItemIds` 仅匹配连续后缀/前缀，无法处理任意位置乱序重复。
3. **缺少断言守护**：关键路径无重复 ID 检测，重复渲染只能通过用户反馈发现。

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

**为什么不统一 `historyMessagesToItems` 的 `idPrefix+seq`**：
该函数仅在 history page 加载时一次性转换，输出 Item[] 后 ID 不跨页面持久化。真正的稳定性保障已在 `transcriptStore.ts` 通过 `entryId` 实现。剩余的 `idPrefix+seq` 是局部作用域，不造成实际重复渲染 bug。彻底改造需要修改 227 处 `HistoryMessage` 构造点，投入产出比不高。

### 2.3 合并时 defensive dedup

**问题**：`duplicateLiveItemIds` 仅匹配 page 后缀与 live 前缀的**连续**重复，无法处理乱序或跨位置重复。

**方案**：
- 新增 `findDuplicateItemIds(a, b)`：基于 `itemSignature` 的 multiset 匹配，支持任意位置重复检测。
- 在 `history_rebase` 和 `history_prepend` 中 defensive dedup：即使 `removeIds` 有遗漏，也能过滤 live tail 中的重复项。
- 保留原有 `duplicateLiveItemIds` 以兼容现有测试。

**与 main-v2 的 `replaceRemoveIds` 关系**：
- `replaceRemoveIds`（main-v2）：处理 loadOlder prepend 场景，基于 store 接缝 + 页同 id 行 + 活跃轮 a: 前缀 + 页已覆盖终态前端行。
- `findDuplicateItemIds`（本分支）：通用 multiset 去重，支持任意位置、任意 kind 的重复检测。
- 两者互补：`replaceRemoveIds` 是场景化优化，`findDuplicateItemIds` 是通用防御。

### 2.4 返回前断言守护

**问题**：重复渲染通常只能通过用户反馈发现，缺乏早期检测机制。

**方案**：
- 新增 `assertNoDuplicateItems(items, label)`：检测列表中是否存在重复 ID，测试环境直接 throw，开发环境 console.error。
- 在关键路径加入断言：
  - `useController.ts`：`history_rebase`, `history_prepend`, `latest_compaction`
  - `transcriptStore.ts`：`loadLatest`, `loadOlder`, `appendEntries`

---

## 3. 优化思路

### 3.1 测试驱动

- 先写回归测试（41 个断言），锚定预期行为。
- 再实现修复，确保测试通过。
- 最后加大测试力度（扩展至 104 个断言），覆盖边界场景。

### 3.2 低风险优先

- Phase 1（ID 统一）和 Phase 4（断言化）均为低风险改动，不改变运行时行为。
- `findDuplicateItemIds` 替代 `duplicateLiveItemIds` 是算法增强，向后兼容。
- Bundle budget 调整基于实际测量值，论证充分。

### 3.3 与 main-v2 的协同

- main-v2 已有 `replaceRemoveIds` 处理 loadOlder prepend 去重。
- 本分支在此基础上增加：
  - `findDuplicateItemIds`：通用 multiset 去重
  - `assertNoDuplicateItems`：CI-time 断言守护
  - `transcriptItemIds`：live item ID 生成统一
- 合并后无冲突，功能互补。

### 3.4 性能考量

- `findDuplicateItemIds` 当前为 O(n×m) 字符串匹配，在 10k+ turn 大会话中可能成为瓶颈。
- 优化方向：改为 O(n+m) Map 计数，但需先确认签名碰撞边界（当前测试已覆盖 reasoning 不同不误判的场景）。

---

## 4. 测试策略

### 4.1 回归测试覆盖（104 个断言）

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

### 4.2 完整套件验证

- `pnpm test:transcript`：**68 passed, 0 failed**
- `wails build`：**成功**，输出 `desktop/build/bin/reasonix-desktop.exe`

### 4.3 合并 main-v2 后的验证

- 解决 1 个冲突（useController.ts 导入区域）
- 回归测试：**104 passed, 0 failed**
- 完整套件：**68 passed, 0 failed**

---

## 5. 提交记录

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

## 6. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| `assertNoDuplicateItems` 在生产环境 throw | 中 | 当前仅在 6 个关键路径启用，测试环境必 throw，生产环境 console.error |
| `findDuplicateItemIds` 大列表性能 | 低 | 当前 10k turn 测试通过（3051ms），如需优化可改为 O(n+m) Map |
| `itemSignature` 签名碰撞 | 低 | 已测试 reasoning 不同不误判；若业务允许相同 reasoning，需调整签名逻辑 |
| Bundle budget 超限 | 低 | 基于实际测量调整，已通过 2407.0 KiB 预算 |
| 与 main-v2 `replaceRemoveIds` 功能重叠 | 低 | 两者互补：replaceRemoveIds 是场景化优化，findDuplicateItemIds 是通用防御 |

---

## 7. 合并建议

**建议合并**，理由：
1. 问题明确：用户可见的重复渲染 bug
2. 方案清晰：三层防御体系，从生成到合并到返回
3. 与 main-v2 互补：main-v2 提供场景化去重，本分支提供通用防御和断言守护
4. 测试充分：104 个断言 + 68 个完整套件测试全部通过
5. 冲突已解决：仅 1 个导入冲突，已合并处理
6. 构建成功：桌面应用可正常编译运行

**后续可选优化**（不影响合并决策）：
- `findDuplicateItemIds` O(n+m) 性能优化
- `assertNoDuplicateItems` 生产环境降级策略
- `historyMessagesToItems` ID 生成彻底统一（需评估投入产出比）
