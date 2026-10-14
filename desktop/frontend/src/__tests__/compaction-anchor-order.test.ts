// compaction-anchor-order.test.ts — codex 复核要求的两个现场证据：
//   ① 锚点插入压缩卡片后，页行（本次 116 条）的**相对顺序**必须与页输入逐一相等
//      （旧的 displacedCount 只是绝对下标差异，不能证明相对错序）；
//   ② history_prepend 不得重复或丢掉 active turn 的 live 行。
// 运行：pnpm exec tsx src/__tests__/compaction-anchor-order.test.ts
import { initialState, reducer } from "../lib/useController";
import type { Item } from "../lib/useController";
import { preserveLiveCompactions, recordCompactionDone } from "../lib/compactionAnchor";

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

type Row = Item & { kind: string; id: string; text?: string };
const row = (id: string, kind: string, text?: string) => ({ id, kind, text }) as unknown as Row;
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

// 116 条页行：58 user + 58 assistant 交替（user 行是锚点的计数单位）。
function pageRows(): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < 58; i += 1) {
    out.push(row(`he:s-page.u${i}`, "user", `问题${i}`));
    out.push(row(`he:s-page.a${i}`, "assistant", `回答${i}`));
  }
  return out;
}

console.log("\ncompaction anchor order");

// 场景 1：锚点卡片插入后，页行相对顺序不变。
{
  const sessionPath = "anchor-order.jsonl";
  const page = pageRows();
  // 卡片在 live 时位于"倒数第 3 条 user 行之前"。
  const prev = [...page.slice(0, 110), row("c.card.1", "compaction", "摘要"), ...page.slice(110)];
  recordCompactionDone(sessionPath, prev, 110, row("c.card.1", "compaction", "摘要"));

  const merged = preserveLiveCompactions(sessionPath, prev, pageRows()) as Row[];
  const withoutCard = merged.filter((r) => r.kind !== "compaction");

  ok(withoutCard.length === 116, `合并后页行数仍为 116（实际 ${withoutCard.length}）`);
  ok(
    JSON.stringify(ids(withoutCard)) === JSON.stringify(ids(pageRows())),
    "剔除卡片后，116 条页行的相对顺序与页输入逐一相等",
  );
  const cardIndex = merged.findIndex((r) => r.id === "c.card.1");
  ok(cardIndex >= 0, "卡片被插回（未被丢弃）");
  ok(
    cardIndex >= 0 && merged[cardIndex + 1]?.kind === "user",
    "卡片落在锚点 user 行之前（不是落到末尾）",
  );
  ok(merged.filter((r) => r.kind === "compaction").length === 1, "卡片不重复");
}

// 场景 2：active turn 的 live 行不重复、不丢失。
{
  let s = reducer(initialState, { type: "meta", meta: { sessionPath: "t-live.jsonl" } } as never);
  s = reducer(s, { type: "user", text: "当前 turn 的话" } as never);
  const live = s.items.map((it) => it.id);
  ok(live.length >= 1, "active turn 有 live 行");

  // 页到达：只移除页覆盖到的行，live 行不在 removeIds 里。
  s = reducer(s, {
    type: "history_prepend",
    items: pageRows().slice(0, 8) as unknown as Item[],
    removeIds: [],
    startTurn: 1,
    totalTurns: 8,
    hasOlder: false,
    revision: 1,
  } as never);

  const after = s.items.map((it) => it.id);
  ok(
    live.every((id) => after.includes(id)),
    "active turn 的 live 行未被 prepend 丢弃",
  );
  ok(
    new Set(after).size === after.length,
    "合并后不存在重复行 id",
  );
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);