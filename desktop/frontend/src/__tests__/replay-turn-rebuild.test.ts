// Run: tsx src/__tests__/replay-turn-rebuild.test.ts
//
// 链 a 场景（v1.38.24 源码实测，报告 §4.2 补充实证）：
// epoch 变化/接管 → observeRuntime 清空投影状态 → 整轮重放 × 屏幕已有 items
// 现状缺陷：重放 text delta 追加到已有 live 缓冲 → 翻倍；已落盘段与重放重建行并存 → 双行。
// 修复语义：重放开始前 dispatch replay_turn_rebuild → 清本轮旧行 → 重放从零重建（挂 user 锚点）。
// 真实形状约束：live assistant 行 text 在 items 中为 ""（正文在 live 缓冲）；页行 id = h<startTurn>-<seq>；
// tool 行用后端 id；事件流无 user 事件。

import type { AppBindings } from "../lib/bridge";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: {} as AppBindings } } } as Window,
});

const [{ initialState, reducer }, { TurnEventProjector }] = await Promise.all([
  import("../lib/useController"),
  import("../lib/turnEventProjection"),
]);
const { transcriptDuplicateSignatureCount, replayRebuildSnapshot } = await import("../lib/replayRebuild");

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

const assistant = (id: string, text: string, streaming: boolean): Item =>
  ({ kind: "assistant", id, text, reasoning: "", streaming, wasStreamed: true }) as Item;
const user = (id: string, text: string): Item => ({ kind: "user", id, text }) as Item;

// 切走前的真实形态：页两轮 + 当前轮乐观 user + 当前轮流式残留（a:* 行，text 为空，正文在 live）
function switchAwayState(): ReducerState {
  return {
    ...initialState,
    items: [
      user("h0-0", "old question"),
      assistant("h0-1", "old answer", false),
      user("u0", "running question"),
      // 当前轮的已落盘残留（多段轮已结算段，页 h 行）与流式 a 行并存
      assistant("h0-2", "settled segment", false),
      assistant("a:turn-x:0", "", false),
      assistant("a:turn-x:1", "", true),
    ],
    historyPrefixCount: 4,
    historyStartTurn: 0,
    historyTotalTurns: 2,
    currentAssistant: "a:turn-x:1",
    assistantSegmentOrdinal: 2,
    activeTurnId: "turn-x",
    turnActive: true,
    running: true,
    live: { id: "a:turn-x:1", text: "streamed so far", reasoning: "", reasoningComplete: false },
  };
}

console.log("\nreplay_turn_rebuild reducer semantics");

{
  const state = switchAwayState();
  const rebuilt = reducer(state, { type: "replay_turn_rebuild", turnId: "turn-x" } as never);
  const ids = rebuilt.items.map((item) => item.id);
  eq(ids.includes("a:turn-x:0"), false, "rebuild drops this turn's live/residual a:* rows");
  eq(ids.includes("a:turn-x:1"), false, "rebuild drops the streaming a:* row");
  eq(ids.includes("h0-2"), false, "rebuild drops the current turn's settled residue left of the anchor");
  eq(ids.includes("h0-0"), true, "rebuild keeps the older page rows");
  eq(ids.includes("h0-1"), true, "rebuild keeps the older page assistant row");
  eq(ids.includes("u0"), true, "rebuild keeps the optimistic user anchor");
  eq(rebuilt.currentAssistant, undefined, "rebuild clears the assistant pointer");
  eq(rebuilt.assistantSegmentOrdinal, 0, "rebuild resets the segment ordinal");
  eq(rebuilt.live, undefined, "rebuild clears the live buffer");
}

{
  // 无 user 行的退化形态（reset 后仅有 a:* 行）：只清 a:*，不误删其它
  const state = {
    ...initialState,
    items: [assistant("a:turn-x:0", "", true), assistant("a:turn-y:0", "", true)] as Item[],
    currentAssistant: "a:turn-x:0",
    assistantSegmentOrdinal: 1,
    activeTurnId: "turn-x",
  };
  const rebuilt = reducer(state, { type: "replay_turn_rebuild", turnId: "turn-x" } as never);
  const ids = rebuilt.items.map((item) => item.id);
  eq(ids.includes("a:turn-x:0"), false, "anchor-less rebuild drops only the target turn's rows");
  eq(ids.includes("a:turn-y:0"), true, "anchor-less rebuild keeps other turns' rows");
}

console.log("\nreplayed turn applies exactly once after rebuild");

{
  // 修复路径：rebuild → 重放从零重建 → 单段轮 text 等于重放全文（不翻倍）
  let state = switchAwayState();
  state = reducer(state, { type: "replay_turn_rebuild", turnId: "turn-x" } as never);
  state = reducer(state, { type: "event", e: { kind: "turn_started", turnId: "turn-x", turnStartedAt: 100 } });
  state = reducer(state, { type: "event", e: { kind: "text", turnId: "turn-x", text: "hello world" } });
  state = reducer(state, { type: "event", e: { kind: "message", turnId: "turn-x", text: "hello world", reasoning: "" } });
  const turnRows = state.items.filter((item) => item.kind === "assistant" && (item.id === "a:turn-x:0" || item.id.startsWith("a:turn-x:")));
  eq(turnRows.length, 1, "exactly one rebuilt assistant row for the turn");
  eq(turnRows[0]?.text, "hello world", "rebuilt row text equals the replayed full text (no doubling)");
  eq(state.items.some((item) => item.id === "u0"), true, "user anchor survives the replayed rebuild");
  eq(state.items.some((item) => item.id === "h0-2"), false, "settled residue stays gone (no h/a duplicate pair)");
}

{
  // 现状 bug 复现（对照）：不 rebuild，重放 delta 直接追加进已有 live 缓冲 → 翻倍。
  // 修复不改变 applyEvent 的追加语义，它把清理放在重放开始之前。
  // （message 结算会全文覆盖修复行内容——持久翻倍只出现在结算前的 live 缓冲，这正是用户可见的重复窗口。）
  let state = switchAwayState();
  state = reducer(state, { type: "event", e: { kind: "turn_started", turnId: "turn-x", turnStartedAt: 100 } });
  state = reducer(state, { type: "event", e: { kind: "text", turnId: "turn-x", text: "hello world" } });
  eq(state.live?.id, "a:turn-x:1", "baseline: replay lands on the existing currentAssistant buffer");
  eq(state.live?.text, "streamed so farhello world", "baseline bug: replayed delta doubles the live buffer");
}

console.log("\nrow-level forensics helpers");

{
  eq(transcriptDuplicateSignatureCount(switchAwayState().items), 0, "no duplicates in a clean mounted transcript (empty rows excluded)");
  const dupItems: Item[] = [
    ...switchAwayState().items,
    assistant("h9-9", "old answer", false),          // same signature as h0-1 (settled content)
    assistant("a:turn-x:2", "", true),               // empty streaming row — excluded from the count
  ];
  eq(transcriptDuplicateSignatureCount(dupItems), 1, "one settled duplicate pair; empty rows do not count");
  const snapshot = replayRebuildSnapshot(switchAwayState(), "turn-x");
  eq(snapshot.rows, 6, "snapshot counts all rows");
  eq(snapshot.liveRows, 2, "snapshot counts this turn's a:* rows");
  eq(snapshot.userRows, 2, "snapshot counts user rows (page + optimistic)");
  eq(snapshot.anchor, "u0", "snapshot anchors on the last user row");
}

console.log("\nTurnEventProjector fires replayStart before the first replayed envelope");

{
  const projector = new TurnEventProjector();
  const events: string[] = [];
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));
  projector.bindReplayStart?.((tabId: string, turnId?: string) => {
    events.push(`replay-start:${tabId}:${turnId ?? ""}`);
  });
  eq(typeof (projector as unknown as { bindReplayStart?: unknown }).bindReplayStart, "function", "projector exposes bindReplayStart");

  // epoch 变化 + active=true + latest(12) > replayAfter(3) → 整轮重放，replayStart 必须先于投影
  const replayView = {
    events: [
      { turnId: "turn-x", seq: 4, status: "in_progress", event: { kind: "turn_started", turnId: "turn-x" } },
      { turnId: "turn-x", seq: 5, status: "in_progress", event: { kind: "text", turnId: "turn-x", text: "durable" } },
    ],
    floorSeq: 4,
    latestSeq: 5,
    nextAfterSeq: 5,
    hasMore: false,
    resetRequired: false,
    runtimeEpoch: "epoch-b",
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { go: { main: { App: { TurnEventsForTab: async () => replayView } as unknown as AppBindings } } } as Window,
  });
  // 重新加载 turnEventProjection 以获取新 mock？不必——projector 通过 app bridge 动态调用。
  const { app } = await import("../lib/bridge");
  (app as unknown as { TurnEventsForTab: unknown }).TurnEventsForTab = async () => replayView;

  projector.observeRuntime("tab-a", "epoch-a", 3, 3, true);
  projector.acceptLive("tab-a", { kind: "text", seq: 3, runtimeEpoch: "epoch-a" }, "epoch-a");
  projector.observeRuntime("tab-a", "epoch-b", 12, 3, true, "turn-x");
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();

  eq(events.length > 0, true, "replayStart fired on epoch change with a full-turn replay");
  eq(events[0]?.startsWith("replay-start:tab-a"), true, "replayStart carries the tab id");
  eq(events[0]?.endsWith("turn-x"), true, "replayStart carries the active turn id");
  eq(projected.length, 2, "full-turn replay projected after the reset signal");
}
