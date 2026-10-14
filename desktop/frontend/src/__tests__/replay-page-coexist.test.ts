// Run: tsx src/__tests__/replay-page-coexist.test.ts
//
// v2 日志（98480416）定死的真实时序：
//   reset（items=0）→ 整轮重放重建当前轮全部段落（a:* 行，已结算 text）
//   → 历史页 prepend（页里含同一轮的 user 行 + 已落盘段）
//   → 页行与重放重建行并存 → turn-done-snapshot 实测 dup=16（持久重复）。
// 修复：页 prepend 时若页覆盖当前轮（页与既有行存在同内容签名），把重放重建行
// （a:<turnId>:* 与同 id 的 tool 行）加入 removeIds，让页拥有该轮；
// currentAssistant/live 指向被剔行时由 reducer 清空，后续 delta 重新衔接。

import type { AppBindings } from "../lib/bridge";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: {} as AppBindings } } } as Window,
});

const [{ initialState, reducer }, { pageOverlapsLiveContent }] = await Promise.all([
  import("../lib/useController"),
  import("../lib/hydrateHistoryApply"),
]);

type ReducerState = ReturnType<typeof reducer>;
type Item = ReducerState["items"][number];

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}

const event = (state: ReducerState, e: unknown): ReducerState => reducer(state, { type: "event", e } as never);

// 真实时序：reset 后整轮重放重建（多段轮，已结算 text 非空）
function replayedState(): ReducerState {
  let s = initialState;
  s = event(s, { kind: "turn_started", turnId: "turn-x", turnStartedAt: 100 });
  s = event(s, { kind: "text", turnId: "turn-x", text: "seg1" });
  s = event(s, { kind: "message", turnId: "turn-x", text: "seg1 full", reasoning: "" });
  s = event(s, { kind: "tool_dispatch", turnId: "turn-x", tool: { id: "tool-1", name: "grep", args: "q", readOnly: true, readOnlyResolved: true } });
  s = event(s, { kind: "tool_result", turnId: "turn-x", tool: { id: "tool-1", name: "grep", args: "q", output: "result", readOnly: true } });
  s = event(s, { kind: "text", turnId: "turn-x", text: "seg2" });
  s = event(s, { kind: "message", turnId: "turn-x", text: "seg2 full", reasoning: "" });
  return s;
}

// 与重放内容同源的页（当前轮 user 行 + 已落盘段；tool 行同后端 id）
const pageItems: Item[] = [
  { kind: "user", id: "h58-0", text: "running question" } as Item,
  { kind: "assistant", id: "h58-1", text: "seg1 full", reasoning: "", streaming: false } as Item,
  { kind: "tool", id: "tool-1", name: "grep", args: "q", status: "done", output: "result", readOnly: true } as Item,
  { kind: "assistant", id: "h58-2", text: "seg2 full", reasoning: "", streaming: false } as Item,
];

console.log("\npageOverlapsLiveContent");
{
  eq(pageOverlapsLiveContent(pageItems, replayedState().items), true, "page whose persisted rows match replayed rows overlaps");
  eq(pageOverlapsLiveContent([{ kind: "user", id: "h1-0", text: "unrelated" } as Item], replayedState().items), false, "an unrelated page does not overlap");
  eq(pageOverlapsLiveContent(pageItems, []), false, "no live rows means no overlap");
}

console.log("\npage apply after a full-turn replay owns the turn (no co-mounted duplicates)");

{
  // 模拟调用点逻辑：页覆盖当前轮 → removeIds 扩展为 a:<turnId>:* + 与页同 id 的既有行
  const state = replayedState();
  const liveItems = state.items;
  const removeIds = new Set<string>();
  if (pageOverlapsLiveContent(pageItems, liveItems)) {
    const prefix = "a:turn-x:";
    for (const item of liveItems) if (item.id.startsWith(prefix)) removeIds.add(item.id);
  }
  const pageIds = new Set(pageItems.map((item) => item.id));
  for (const item of liveItems) if (pageIds.has(item.id)) removeIds.add(item.id);

  const applied = reducer(state, { type: "history_prepend", items: pageItems, removeIds: Array.from(removeIds), startTurn: 58, totalTurns: 60, hasOlder: false } as never);
  const ids = applied.items.map((item) => item.id);
  eq(ids.filter((id) => id === "a:turn-x:0").length + ids.filter((id) => id === "a:turn-x:1").length, 0, "replayed assistant rows are dropped when the page owns the turn");
  eq(ids.filter((id) => id === "tool-1").length, 1, "same-id tool row survives exactly once (page copy)");
  eq(ids.includes("h58-0"), true, "page user anchor is the turn's only heading");
  eq(applied.items.filter((item) => item.kind === "assistant" && item.text === "seg1 full").length, 1, "settled segment exists exactly once");
  eq(applied.currentAssistant, undefined, "dangling assistant pointer is cleared with the dropped rows");
}

{
  // 页不含当前轮（无签名交集）→ 重放行必须保留（否则丢内容）
  const state = replayedState();
  const unrelatedPage: Item[] = [{ kind: "user", id: "h1-0", text: "old" } as Item];
  const applied = reducer(state, { type: "history_prepend", items: unrelatedPage, removeIds: [], startTurn: 1, totalTurns: 2, hasOlder: false } as never);
  eq(applied.items.some((item) => item.id === "a:turn-x:0"), true, "without overlap the replayed rows are kept");
}

console.log("\nlive deltas reattach after the page owns the turn");

{
  let state = replayedState();
  const removeIds = state.items.filter((item) => item.id.startsWith("a:turn-x:")).map((item) => item.id);
  state = reducer(state, { type: "history_prepend", items: pageItems, removeIds, startTurn: 58, totalTurns: 60, hasOlder: false } as never);
  // 页 apply 后 live 流继续：新 delta 应新建行并正常衔接（不复活被剔行、不撞 id）
  state = event(state, { kind: "text", turnId: "turn-x", text: "seg3" });
  eq(state.live?.text, "seg3", "post-page delta streams into a fresh live buffer");
  eq(state.items.some((item) => item.id === "a:turn-x:2"), true, "post-page delta creates a fresh row");
  state = event(state, { kind: "message", turnId: "turn-x", text: "seg3 full", reasoning: "" });
  eq(state.items.filter((item) => item.kind === "assistant" && item.text === "seg3 full").length, 1, "post-page segment settles exactly once");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
