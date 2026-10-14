// compaction-prepend-order.test.ts — 卡片先到、历史后到时压缩卡片保持顶部：
// 切回走 runtime.rebuilt 时，latest_compaction 先 unshift 卡片（items=[card]），
// 随后 history_prepend 把历史页插到前面——合并必须把 rest 中的卡片重新放回
// 顶部（日志实证：c.c5.0 落到 97 条历史之后成为最后一条）。
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
    s.items[0].kind === "compaction",
    "history_prepend 合并后卡片仍在顶部（而不是落在历史之后）",
  );
  ok(
    s.items[s.items.length - 1].kind !== "compaction",
    "卡片不再是最后一条",
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

  ok(s.items[0].kind === "compaction", "live 行被页覆盖后卡片仍保持顶部");
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
