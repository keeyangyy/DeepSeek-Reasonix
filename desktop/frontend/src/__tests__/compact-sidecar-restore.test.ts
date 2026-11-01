// compact-sidecar-restore.test.ts — 切回（hydrate）后从 sidecar 恢复压缩记录：
// 压缩在 tab 释放期间完成（切走），done 事件流不可达，只有磁盘 sidecar 能
// 在重新打开会话时恢复压缩摘要卡片。
//
// 位置看 sidecar 里的 anchorMessageId：锚点消息已加载就显示在它之后；还没加载
// 就不显示（而不是猜一个位置，那正是以前卡片乱跑的来源）。
// 运行：node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/compact-sidecar-restore.test.ts
import { initialState, reducer } from "../lib/useController";
import type { HistoryMessage } from "../lib/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { process.stdout.write(`  PASS  ${label}\n`); passed += 1; }
  else { process.stdout.write(`  FAIL  ${label}\n`); failed += 1; }
}

console.log("\ncompact sidecar restore");

// 切回场景：hydrate（history 重建）→ latest_compaction（sidecar 记录恢复）
{
  const history: HistoryMessage[] = [
    { role: "user", content: "问题", id: "U1" },
    { role: "assistant", content: "回答", id: "A1" },
  ] as HistoryMessage[];
  const hydrated = reducer(initialState, { type: "history", messages: history, seq: 3 } as never);
  const restored = reducer(hydrated, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 14, summary: "切走期间完成的压缩摘要", anchorMessageId: "A1" },
  } as never);
  const cards = restored.items.filter((it) => it.kind === "compaction");
  ok(cards.length === 1, "latest_compaction 恢复一张压缩卡片");
  ok(cards[0]?.summary === "切走期间完成的压缩摘要", "摘要内容正确");
  ok(cards[0]?.messages === 14, "消息数正确");
  ok(restored.items[restored.items.length - 1]?.kind === "compaction", "卡片落在锚点消息之后");
}

// 锚点消息还没加载：不显示，而不是猜位置
{
  const hydrated = reducer(initialState, { type: "history", messages: [{ role: "user", content: "问题", id: "U1" }] as HistoryMessage[], seq: 2 } as never);
  const restored = reducer(hydrated, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 9, summary: "未加载锚点", anchorMessageId: "NOT-LOADED" },
  } as never);
  ok(restored.items.filter((it) => it.kind === "compaction").length === 0, "锚点消息未加载时不显示卡片");
}

// 旧记录（没有锚点字段）：同样不显示
{
  const hydrated = reducer(initialState, { type: "history", messages: [{ role: "user", content: "问题", id: "U1" }] as HistoryMessage[], seq: 2 } as never);
  const restored = reducer(hydrated, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 3, summary: "旧记录" },
  } as never);
  ok(restored.items.filter((it) => it.kind === "compaction").length === 0, "旧记录缺少锚点时卡片不显示");
}

// 去重：同 summary 的重复恢复不叠加
{
  const restored = reducer(initialState, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 3, summary: "去重摘要", anchorMessageId: "A1" },
  } as never);
  const again = reducer(restored, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 3, summary: "去重摘要", anchorMessageId: "A1" },
  } as never);
  ok(again.items.filter((it) => it.kind === "compaction").length <= 1, "相同摘要不重复叠加");
}

// pending 卡片先出现，完成记录到位后填充同一张
{
  const hydrated = reducer(initialState, { type: "history", messages: [{ role: "user", content: "问题", id: "U1" }] as HistoryMessage[], seq: 2 } as never);
  const pending = reducer(hydrated, { type: "latest_compaction", tabId: "t1", record: { inProgress: true } } as never);
  ok(pending.items.some((it) => it.kind === "compaction" && it.pending), "压缩中的卡片先出现");

  const done = reducer(pending, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 5, summary: "完成摘要", anchorMessageId: "U1" },
  } as never);
  const cards = done.items.filter((it) => it.kind === "compaction");
  ok(cards.length === 1, "完成记录填充 pending 卡片（不新增一张）");
  ok(cards[0]?.pending === false && cards[0]?.summary === "完成摘要", "填充后不再是 pending，摘要正确");
}

process.stdout.write(`\ncompact sidecar restore: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
