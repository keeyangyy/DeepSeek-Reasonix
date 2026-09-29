// Run: tsx src/__tests__/hydrate-prepend-replay-rows.test.ts
//
// 现场日志 reasonix-frontend-diagnostics-bfb949b2（buildCommit 418eb30）定死的残留机制：
//   重新进入一个仍在运行的会话 → hydrate 走 prepend 分支：
//     t=3987  items.tail total=2   items=[c.c2.0, a:turn_40329b..:0]
//     t=4071  history_prepend total=116（页 114 条 + card + 重建行）
//     尾部 = [a:turn:0, n125, t.call_01, t.call_00, a:turn:133, n124]
//   → 未落盘 turn 的 replay 重建行 a:<turnId>:<ordinal> 停在整页历史【之后】
//     （视觉上「几条会话跑到最底下」）。
//     t=10947 用户上滑触发 loadOlder，items.removed=[a:turn:245, a:turn:133, a:turn:0]
//   → 走 replaceRemoveIds 的前缀判据才清掉 → 「上滑加载后又变正常」。
//
// 缺口：hydrate 的 removeIds 三条判据同时失效——
//   1) duplicateLiveItemIds 只匹配「页后缀 vs live 前缀」的连续重复；
//   2) projection.openTurnId 在该 turn 已落盘、open marker 已清时为空；
//   3) pageOverlapsLiveContent 要求 live 侧存在非空文本，而重建行文本为空 →
//      提前 return false，整块清理由此被跳过。
//
// 修复：hydrate prepend 增加「页已接管在途 turn」判据——页的最后一条 user 行
// 之后若仍有 assistant/tool 行，说明该页已携带当前在途 turn 的持久输出
// （hydrate 取的永远是 latest page），此时按 a:<turnId>: 前缀清掉重建行。
// 反向保护：页不含当前轮输出时必须【保留】重建行（删了即丢内容）。
import { initialState, reducer } from "../lib/useController";
import type { Item } from "../lib/useController";
import {
  duplicateLiveItemIds,
  pageCoveredLiveItemIds,
  pageOverlapsLiveContent,
  pageSupersedesInFlightTurn,
} from "../lib/hydrateHistoryApply";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}

// ── 日志同形的行构造 ──────────────────────────────────────────────────────
const TURN = "turn_40329b03052e91e36a52cd81318";
const card: Item = { kind: "compaction", id: "c2", pending: false, trigger: "manual", messages: 462, summary: "压缩摘要", archive: "" } as never;
const seg = (ordinal: number, text = ""): Item =>
  ({ kind: "assistant", id: `a:${TURN}:${ordinal}`, text, reasoning: "", streaming: true }) as never;

// 页：若干历史轮（user + assistant + tool）+ 最后一轮已落盘输出。
// 末条是当前在途 turn 的持久输出 → 页确实接管了该 turn。
function pageWithPersistedTurnOutput(): Item[] {
  const out: Item[] = [];
  for (let t = 0; t < 12; t += 1) {
    out.push({ kind: "user", id: `h5-${t}-u`, text: `问题${t}`, historyTurn: t + 1 } as never);
    out.push({ kind: "assistant", id: `he:a${t}`, text: `回答${t}`, reasoning: "" } as never);
    out.push({ kind: "tool", id: `call_${t}`, name: "shell", status: "done" } as never);
  }
  out.push({ kind: "user", id: "h5-last-u", text: "当前问题", historyTurn: 13 } as never);
  out.push({ kind: "tool", id: "call_00_BEUF0lNlXUcijDpv81qh1488", name: "shell", status: "done" } as never);
  return out;
}

// 页以「当前轮 user 行」结尾：该轮尚无落盘输出，重建行必须保留。
const pageEndingAtUser: Item[] = [
  { kind: "user", id: "h5-0-u", text: "旧问题", historyTurn: 1 } as never,
  { kind: "assistant", id: "he:a0", text: "旧回答", reasoning: "" } as never,
  { kind: "user", id: "h5-1-u", text: "当前问题", historyTurn: 2 } as never,
];

// 无关页：不含当前轮任何行。
const unrelatedPage: Item[] = [{ kind: "user", id: "h1-0", text: "old" } as never];

// 与 useController 的 hydrate prepend 分支同构的 removeIds 复刻（保持同步：
// 判据即 projection.items / liveItems / activeTurnId 三者的组合）。
function hydrateRemoveIds(page: Item[], live: Item[], activeTurnId: string | undefined): string[] {
  const removeIds = duplicateLiveItemIds(page, live);
  if (pageOverlapsLiveContent(page, live) || pageSupersedesInFlightTurn(page, live)) {
    const prefix = activeTurnId ? `a:${activeTurnId}:` : undefined;
    for (const item of live) {
      if ((prefix && item.id.startsWith(prefix)) || page.some((pageItem) => pageItem.id === item.id)) removeIds.push(item.id);
    }
    removeIds.push(...pageCoveredLiveItemIds(page, live));
  }
  return removeIds;
}

console.log("\nhydrate prepend: page-owned in-flight turn rows must not trail the page");

// ── 判据函数本身 ─────────────────────────────────────────────────────────
eq(pageSupersedesInFlightTurn(pageWithPersistedTurnOutput(), [seg(0)]), true, "页在末条 user 行之后仍有输出行 + 重建行为空 → 判定接管");
eq(pageSupersedesInFlightTurn(pageWithPersistedTurnOutput(), [seg(0, "已流出内容")]), false, "重建行已有内容 → 不判定接管（交给内容匹配，避免误删）");
eq(pageSupersedesInFlightTurn(pageEndingAtUser, [seg(0)]), false, "页以 user 行结尾（无该轮输出）→ 不判定接管");
eq(pageSupersedesInFlightTurn(unrelatedPage, [seg(0)]), false, "页只有 user 行 → 不判定接管");
eq(pageSupersedesInFlightTurn([], [seg(0)]), false, "空页 → 不判定接管");

// ── 反向保护：页尾是【上一轮】输出 + 重建行已有流式内容 → 不得误删 ────────
{
  const prevTurnPage: Item[] = [
    { kind: "user", id: "h5-0-u", text: "上一问", historyTurn: 1 } as never,
    { kind: "assistant", id: "he:a0", text: "上一答", reasoning: "" } as never,
    { kind: "tool", id: "call_prev", name: "shell", status: "done" } as never,
  ];
  const state: ReturnType<typeof reducer> = {
    ...initialState,
    meta: { sessionPath: "session.jsonl", sessionRevision: 12 },
    running: true,
    turnActive: true,
    activeTurnId: TURN,
    historyTotalTurns: 0,
    historyStartTurn: 0,
    historyPrefixCount: 0,
    items: [seg(0, "正在生成的重要内容")],
    currentAssistant: `a:${TURN}:0`,
  } as never;

  const removeIds = hydrateRemoveIds(prevTurnPage, state.items, TURN);
  const next = reducer(state, {
    type: "history_prepend",
    items: prevTurnPage,
    removeIds,
    startTurn: 1,
    totalTurns: 2,
    hasOlder: false,
    revision: 12,
  } as never);

  eq(next.items.some((item) => item.id === `a:${TURN}:0`), true, "页尾是上一轮输出时，已有内容的重建行不被误删");
}

// ── 场景 1（本次 bug）────────────────────────────────────────────────────
{
  // 日志 t=3987 同形：prepend 前 live 只有卡片 + 空壳重建行。
  const state: ReturnType<typeof reducer> = {
    ...initialState,
    meta: { sessionPath: "session.jsonl", sessionRevision: 12 },
    running: true,
    turnActive: true,
    activeTurnId: TURN,
    historyTotalTurns: 0,
    historyStartTurn: 0,
    historyPrefixCount: 0,
    items: [card, seg(0)],
    currentAssistant: `a:${TURN}:0`,
  } as never;

  const page = pageWithPersistedTurnOutput();
  const removeIds = hydrateRemoveIds(page, state.items, TURN);
  const next = reducer(state, {
    type: "history_prepend",
    items: page,
    removeIds,
    startTurn: 1,
    totalTurns: 13,
    hasOlder: true,
    revision: 12,
  } as never);

  const trailing = next.items.filter((item) => item.id.startsWith(`a:${TURN}:`));
  eq(trailing.map((item) => item.id), [], "页已含当前轮输出时，重建行不再排在页后（bug 修复点）");
  eq(next.items.filter((item) => item.id === "call_00_BEUF0lNlXUcijDpv81qh1488").length, 1, "同 id 的 tool 行只保留页内一份");
  eq(next.items[0]?.kind, "compaction", "压缩卡片仍归位顶部");
  eq(next.items[next.items.length - 1]?.id.startsWith(`a:${TURN}:`), false, "最末一条不再是回放行");
}

// ── 场景 2：页不含当前轮输出 → 重建行必须保留（否则丢内容）──────────────
{
  const state: ReturnType<typeof reducer> = {
    ...initialState,
    meta: { sessionPath: "session.jsonl", sessionRevision: 12 },
    running: true,
    turnActive: true,
    activeTurnId: TURN,
    historyTotalTurns: 0,
    historyStartTurn: 0,
    historyPrefixCount: 0,
    items: [card, seg(0, "正在生成的内容")],
    currentAssistant: `a:${TURN}:0`,
  } as never;

  const removeIds = hydrateRemoveIds(unrelatedPage, state.items, TURN);
  const next = reducer(state, {
    type: "history_prepend",
    items: unrelatedPage,
    removeIds,
    startTurn: 1,
    totalTurns: 2,
    hasOlder: false,
    revision: 12,
  } as never);

  eq(next.items.some((item) => item.id === `a:${TURN}:0`), true, "页不含当前轮时保留重建行（反向保护）");
}

// ── 场景 3：页以当前轮 user 行结尾（该轮尚无落盘输出）→ 同样必须保留 ──────
{
  const state: ReturnType<typeof reducer> = {
    ...initialState,
    meta: { sessionPath: "session.jsonl", sessionRevision: 12 },
    running: true,
    turnActive: true,
    activeTurnId: TURN,
    historyTotalTurns: 0,
    historyStartTurn: 0,
    historyPrefixCount: 0,
    items: [card, seg(0)],
    currentAssistant: `a:${TURN}:0`,
  } as never;

  const removeIds = hydrateRemoveIds(pageEndingAtUser, state.items, TURN);
  const next = reducer(state, {
    type: "history_prepend",
    items: pageEndingAtUser,
    removeIds,
    startTurn: 1,
    totalTurns: 2,
    hasOlder: false,
    revision: 12,
  } as never);

  eq(next.items.some((item) => item.id === `a:${TURN}:0`), true, "页以 user 行结尾（无该轮输出）时保留重建行，不白屏");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
