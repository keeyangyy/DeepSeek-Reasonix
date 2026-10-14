// compact-sidecar-restore.test.ts — 切回（hydrate）后从 sidecar 恢复压缩记录：
// 压缩在 tab 释放期间完成（切走），done 事件流不可达，只有磁盘 sidecar 能
// 在重新打开会话时恢复压缩摘要卡片。
// 运行：pnpm exec tsx src/__tests__/compact-sidecar-restore.test.ts
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
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答" },
  ] as HistoryMessage[];
  const hydrated = reducer(initialState, { type: "history", messages: history, seq: 3 } as never);
  const restored = reducer(hydrated, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 14, summary: "切走期间完成的压缩摘要" },
  } as never);
  const cards = restored.items.filter((it) => it.kind === "compaction");
  ok(cards.length === 1, "latest_compaction 恢复一张压缩卡片");
  ok(cards[0]?.summary === "切走期间完成的压缩摘要", "摘要内容正确");
  ok(cards[0]?.messages === 14, "消息数正确");
  ok(restored.items[0]?.kind === "user", "历史内容保留在卡片之前");
}

// 去重：同 summary 的重复恢复不叠加
{
  const restored = reducer(initialState, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 3, summary: "去重摘要" },
  } as never);
  const again = reducer(restored, {
    type: "latest_compaction",
    tabId: "t1",
    record: { trigger: "manual", messages: 3, summary: "去重摘要" },
  } as never);
  ok(again.items.filter((it) => it.kind === "compaction").length === 1, "相同摘要不重复叠加");
}

// 空记录 / 无摘要：不渲染
{
  const noop = reducer(initialState, { type: "latest_compaction", tabId: "t1", record: { summary: "" } } as never);
  ok(noop.items.filter((it) => it.kind === "compaction").length === 0, "空摘要不渲染");
}

// inProgress（切回时压缩仍在跑）→ 挂"正在压缩中"卡片；完成后填充
{
  const progress = reducer(initialState, { type: "latest_compaction", tabId: "t1", record: { inProgress: true } } as never);
  const pending = progress.items.filter((it) => it.kind === "compaction");
  ok(pending.length === 1 && pending[0]?.pending === true, "inProgress 挂起一张 pending 压缩卡片");
  const done = reducer(progress, { type: "latest_compaction", tabId: "t1", record: { trigger: "manual", messages: 8, summary: "轮询后完成摘要" } } as never);
  const cards = done.items.filter((it) => it.kind === "compaction");
  ok(cards.length === 1 && cards[0]?.pending === false && cards[0]?.summary === "轮询后完成摘要", "完成记录填充 pending 卡片");
}

console.log(`\ncompact sidecar restore: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;