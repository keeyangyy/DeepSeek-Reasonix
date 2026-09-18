// compaction-visible.test.ts — 压缩反馈可见性：compaction 卡片行必须
// 独立于折叠状态渲染（不再藏进默认收起的折叠体）。
// 运行：tsx src/__tests__/compaction-visible.test.ts
import { buildTranscriptRowBlocks, buildTurnModels, partitionTurnItems, EMPTY_FOLDS } from "../lib/transcriptRows";
import type { Item } from "../lib/useController";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { process.stdout.write(`  PASS  ${label}\n`); passed += 1; }
  else { process.stdout.write(`  FAIL  ${label}\n`); failed += 1; }
}

function buildFixture(): Item[] {
  return [
    { kind: "user", id: "u1", text: "prompt 1", optimistic: false } as Item,
    { kind: "assistant", id: "a1", text: "answer 1", reasoning: "", streaming: false } as Item,
    // 空闲压缩追加的 compaction 行（无后续 user）：当前缺陷场景
    { kind: "compaction", id: "c1", pending: true, trigger: "manual", messages: 0, summary: "", archive: "" } as Item,
  ];
}

console.log("\ncompaction visible");

const items = buildFixture();
const models = buildTurnModels(items);
// 全部折叠关闭的空 folds——回归场景：空闲时折叠体默认收起
const blocks = buildTranscriptRowBlocks(models, { folds: EMPTY_FOLDS, turnForUser: () => 1, hasOlderHistory: false, creationMode: false });
const rows = blocks.flatMap((block) => block.rows);

const compactionRows = rows.filter((row) => row.kind === "compaction");
ok(compactionRows.length === 1, "compaction 行存在于 blocks.rows（fold 未开也渲染）");
ok(compactionRows[0]?.kind === "compaction", "compaction 行 kind 正确");
// 归属层：compaction 必须进 outsideItems（常显），绝不进折叠体（processItems）
const parts = partitionTurnItems(items);
ok(parts.every((p) => !p.processItems.some((it) => it.kind === "compaction")), "compaction 不在任何折叠体（processItems）中");
ok(parts.some((p) => p.outsideItems.some((it) => it.kind === "compaction")), "compaction 在 outsideItems（常显路径）中");

console.log(`\ncompaction visible: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;