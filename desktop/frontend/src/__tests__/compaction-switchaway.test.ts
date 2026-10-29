// 复现：压缩进行中关闭会话 → 打开别的会话 → 再切回本会话。
//
// 走真实路径：单标签页切回 = reset（保留 live 压缩卡片）→ history 重建
// （按锚点插回原位），而不是直接 history。漏掉 reset 会得出错误结论。
//
// 重要：liveCompactionsCache 是模块级单例，按 sessionPath 分桶。每个场景必须
// 用独立路径，否则前一个场景的卡片会漏进后一个场景。
//
// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/probe-compaction-switchaway.test.ts

import { initialState, reducer } from "../lib/useController";
import type { HistoryMessage } from "../lib/types";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
  process.stdout.write(`  ${cond ? "PASS" : "FAIL"}  ${label}\n`);
  if (cond) passed += 1;
  else failed += 1;
}

const historyAction = (messages: HistoryMessage[]) => ({ type: "history", messages, seq: 3 }) as never;
const resetAction = () => ({ type: "reset" }) as never;

function freshState(sessionPath: string) {
  return { ...initialState, meta: { sessionPath } } as never;
}

function compactionCards(state: ReturnType<typeof reducer>) {
  return state.items.filter((it) => it.kind === "compaction") as Array<{
    kind: "compaction";
    pending?: boolean;
    summary?: string;
  }>;
}

const turnHistory = (n: number, label: string): HistoryMessage[] =>
  Array.from({ length: n }, (_, i) => [
    { role: "user", content: `${label} 问题 ${i + 1}` },
    { role: "assistant", content: `${label} 回答 ${i + 1}` },
  ]).flat() as HistoryMessage[];

let scenario = 0;
const nextSession = () => `probe-session-${++scenario}.jsonl`;

process.stdout.write("\n压缩中切走 → 切回（真实路径：reset → history）\n");

// ── 场景 1：压缩进行中切走再切回，pending 卡片去留 ──────────────────────
{
  const sessionA = nextSession();
  let a = reducer(freshState(sessionA), historyAction(turnHistory(6, "A")));
  a = reducer(a, { type: "event", e: { kind: "compaction_started", compaction: { trigger: "manual" } } } as never);
  ok(compactionCards(a).length === 1, "压缩开始后出现 1 张 pending 卡片");

  // 切到会话 B：真实顺序是「meta 先换成本会话 → reset → history 重建」，
  // 先 reset 再换 meta 会让 A 的卡片被带进 B（测试动作顺序不真实）。
  const sessionB = nextSession();
  let b = reducer({ ...a, meta: { sessionPath: sessionB } } as never, resetAction());
  b = reducer(b, historyAction(turnHistory(3, "B")));
  ok(compactionCards(b).length === 0, "会话 B 里看不到 A 的压缩卡片");

  // 切回会话 A：reset（此时 s.items 是 B 的）→ history 重建
  let back = reducer({ ...b, meta: { sessionPath: sessionA } } as never, resetAction());
  const afterReset = compactionCards(back).length;
  back = reducer(back, historyAction(turnHistory(6, "A")));
  const afterHistory = compactionCards(back).length;

  process.stdout.write(`    reset 后卡片数=${afterReset}，history 重建后卡片数=${afterHistory}\n`);
  ok(afterHistory >= 1, `切回后压缩卡片仍在（实际 ${afterHistory} 张）`);
}

// ── 场景 2a：压缩进行中切走 → 卡片回到原位（末尾） ──────────────────────
{
  const sessionA = nextSession();
  let a = reducer(freshState(sessionA), historyAction(turnHistory(6, "A")));
  a = reducer(a, { type: "event", e: { kind: "compaction_started", compaction: { trigger: "manual" } } } as never);
  const beforeSwitch = a.items.findIndex((it) => it.kind === "compaction");

  let back = reducer(freshState(sessionA), resetAction());
  back = reducer(back, historyAction(turnHistory(6, "A")));
  const after = back.items.findIndex((it) => it.kind === "compaction");

  process.stdout.write(`    进行中切走：切走前 index=${beforeSwitch}，切回后 index=${after} / 总长=${back.items.length}\n`);
  ok(after === beforeSwitch, `进行中的卡片回到原位（前 ${beforeSwitch} vs 后 ${after}）`);
}

// ── 场景 2b：压缩已完成再切走 → 按既有语义在顶部 ────────────────────────
{
  const sessionA = nextSession();
  let a = reducer(freshState(sessionA), historyAction(turnHistory(6, "A")));
  a = reducer(a, { type: "event", e: { kind: "compaction_started", compaction: { trigger: "manual" } } } as never);
  a = reducer(a, {
    type: "event",
    e: { kind: "compaction_done", compaction: { trigger: "manual", messages: 8, summary: "切走前已完成" } },
  } as never);

  let back = reducer(freshState(sessionA), resetAction());
  back = reducer(back, historyAction(turnHistory(6, "A")));
  const after = back.items.findIndex((it) => it.kind === "compaction");

  process.stdout.write(`    完成后切走：切回后 index=${after} / 总长=${back.items.length}\n`);
  ok(after === 0, `已完成的卡片按既有语义落在顶部（实际 index=${after}）`);
}

// ── 场景 3：切回时没有任何缓存（模拟 pending 卡片未进 cache） ────────────
{
  const session = nextSession();
  let back = reducer(freshState(session), resetAction());
  back = reducer(back, historyAction(turnHistory(6, "A")));
  ok(compactionCards(back).length === 0, "无缓存时切回确实没有卡片（基线）");

  back = reducer(back, { type: "latest_compaction", tabId: "t1", record: { inProgress: true } } as never);
  const idx = back.items.findIndex((it) => it.kind === "compaction");
  process.stdout.write(`    sidecar inProgress 补回卡片 index=${idx} / 总长=${back.items.length}\n`);
  ok(compactionCards(back).length === 1, "sidecar inProgress 能补回一张 pending 卡片");
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
