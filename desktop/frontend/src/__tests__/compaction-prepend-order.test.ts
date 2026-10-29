// compaction-prepend-order.test.ts — 卡片先到、历史后到时按锚点落位：
// 切回走 runtime.rebuilt 时，latest_compaction 可能先到（items 只有卡片），
// 随后 history_prepend 才把历史页插进来。卡片必须按 anchorUsers 找回原来的
// 轮次边界；没有锚点的旧记录落到末尾（压缩边界就是最新一轮），不能悬在
// 历史之前——旧实现把卡片固定在顶部，重建后位置与压缩点无关。
// 运行：pnpm exec tsx src/__tests__/compaction-prepend-order.test.ts
import { initialState, reducer } from "../lib/useController";
import type { Item } from "../lib/useController";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function historyItem(id: string, text: string): Item {
  return { kind: "assistant", id, text, pending: false } as unknown as Item;
}
function pageItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => historyItem(`he:s-page.${i}`, `历史${i}`));
}

console.log("\ncompaction prepend order");

// 场景 1（核心）：latest_compaction 先到（items=[card]）→ history_prepend 到达。
{
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: "t1.jsonl" },
  } as never);
  s = reducer(s, {
    type: "latest_compaction",
    record: { trigger: "manual", messages: 462, summary: "压缩摘要" },
  } as never);
  ok(s.items.length === 1 && s.items[0].kind === "compaction", "卡片先到：unshift 后 items=[card]");

  const removeIds = s.items.filter((it) => it.kind !== "compaction").map((it) => it.id);
  s = reducer(s, {
    type: "history_prepend",
    items: pageItems(97),
    removeIds,
    startTurn: 1,
    totalTurns: 97,
    hasOlder: false,
    revision: 1,
  } as never);

  ok(
    s.items[s.items.length - 1].kind === "compaction",
    "无锚点的旧记录在 history_prepend 后落到历史末尾（不悬在历史之前）",
  );
  ok(
    s.items.filter((it) => it.kind === "compaction").length === 1,
    "合并后只有一张卡片",
  );
  ok(s.items.length === 98, `合并后总数 98（实际 ${s.items.length}）`);
}

// 场景 2：卡片+live 行共存（rebuilt 回放中）→ history_prepend 移除 live 行、保留卡片。
{
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: "t2.jsonl" },
  } as never);
  s = reducer(s, {
    type: "latest_compaction",
    record: { trigger: "manual", messages: 100, summary: "压二" },
  } as never);
  s = reducer(s, { type: "user", text: "第一句" } as never);
  const liveCount = s.items.length;
  ok(liveCount >= 2, "卡片 + live 用户行共存");

  const removeIds = s.items.filter((it) => it.kind !== "compaction").map((it) => it.id);
  s = reducer(s, {
    type: "history_prepend",
    items: pageItems(50),
    removeIds,
    startTurn: 1,
    totalTurns: 50,
    hasOlder: false,
    revision: 2,
  } as never);

  ok(s.items[s.items.length - 1].kind === "compaction", "live 行被页覆盖后卡片仍只有一张，落在页之后");
}

// 场景 3：卡片带锚点（anchorUsers）时，prepend 后落在第 anchorUsers+1 个 user
// 之前——即压缩关闭的那一轮结束处。
{
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: "t3.jsonl" },
  } as never);
  s = reducer(s, {
    type: "latest_compaction",
    record: { trigger: "manual", messages: 12, summary: "压三", anchorUsers: 2 },
  } as never);
  const page: Item[] = [];
  for (let i = 0; i < 5; i += 1) {
    page.push({ kind: "user", id: `he:u${i}`, text: `问${i}` } as unknown as Item);
    page.push({ kind: "assistant", id: `he:a${i}`, text: `答${i}` } as unknown as Item);
  }
  s = reducer(s, {
    type: "history_prepend",
    items: page,
    removeIds: [],
    startTurn: 1,
    totalTurns: 5,
    hasOlder: false,
    revision: 3,
  } as never);
  const cardIndex = s.items.findIndex((it) => it.kind === "compaction");
  const thirdUserIndex = s.items.findIndex((it, index) =>
    it.kind === "user" && s.items.slice(0, index).filter((row) => row.kind === "user").length === 2,
  );
  ok(cardIndex >= 0 && cardIndex === thirdUserIndex - 1, `有锚点的卡片紧贴在第 3 个 user 之前（card=${cardIndex} 第三个user=${thirdUserIndex}）`);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
