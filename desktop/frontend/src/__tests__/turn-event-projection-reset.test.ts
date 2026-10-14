import assert from "node:assert/strict";
import type { AppBindings } from "../lib/bridge";
import type { TurnEventReplayView } from "../lib/types";

let resetEntered!: () => void;
const resetStarted = new Promise<void>((resolve) => { resetEntered = resolve; });
let releaseReset!: () => void;
const resetReleased = new Promise<void>((resolve) => { releaseReset = resolve; });

const replay: TurnEventReplayView = {
  events: [
    {
      turnId: "turn-reset",
      seq: 11,
      status: "in_progress",
      event: { kind: "turn_started", turnId: "turn-reset", status: "in_progress" },
    },
    {
      turnId: "turn-reset",
      seq: 12,
      status: "in_progress",
      event: { kind: "text", turnId: "turn-reset", status: "in_progress", text: "durable" },
    },
  ],
  floorSeq: 11,
  latestSeq: 12,
  nextAfterSeq: 12,
  hasMore: false,
  resetRequired: true,
  transcriptRevision: 7,
  transcriptDigest: "digest-7",
  runtimeEpoch: "epoch-a",
};

const binding: Partial<AppBindings> = {
  TurnEventsForTab: async () => replay,
};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: binding as AppBindings } } } as Window,
});

const [{ TurnEventProjector }, { initialState, reducer }] = await Promise.all([
  import("../lib/turnEventProjection"),
  import("../lib/useController"),
]);

const projected: number[] = [];
const projector = new TurnEventProjector();
projector.bind((event) => projected.push(event.seq ?? 0));
projector.bindReset(async (_tabId, view) => {
  assert.equal(view.transcriptRevision, 7);
  resetEntered();
  await resetReleased;
  return true;
});
projector.observeRuntime("tab", "epoch-a", 1, 1, true);
assert.equal(projector.acceptLive("tab", { kind: "turn_status", seq: 3, runtimeEpoch: "epoch-a" }, "epoch-a"), false);
await resetStarted;
assert.equal(projector.acceptLive("tab", { kind: "turn_done", seq: 13, runtimeEpoch: "epoch-a", status: "completed" }, "epoch-a"), false);
releaseReset();
for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
assert.deepEqual(projected, [11, 12, 13], "checkpoint replay is projected before the queued live tail");

let resolveStaleReplay!: (view: TurnEventReplayView) => void;
binding.TurnEventsForTab = async () => new Promise<TurnEventReplayView>((resolve) => { resolveStaleReplay = resolve; });
const staleProjection: number[] = [];
const releasedProjector = new TurnEventProjector();
releasedProjector.bind((event) => staleProjection.push(event.seq ?? 0));
releasedProjector.observeRuntime("released-tab", "epoch-old", 1, 1, true);
releasedProjector.acceptLive("released-tab", { kind: "turn_status", seq: 3, runtimeEpoch: "epoch-old" }, "epoch-old");
await Promise.resolve();
releasedProjector.release("released-tab");
resolveStaleReplay({ ...replay, resetRequired: false, floorSeq: 2, events: [replay.events[1]] });
for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
assert.deepEqual(staleProjection, [], "a replay response that returns after tab release is discarded");

const persistedAssistant = { kind: "assistant", id: "assistant-live", text: "partial", reasoning: "", streaming: false } as const;
const persistedUser = { kind: "user", id: "persisted-user-live", text: "persisted question" } as const;
const optimisticUser = { kind: "user", id: "optimistic-user", text: "new question" } as const;
const oldHistory = { kind: "user", id: "history-old", text: "old question" } as const;
const state = {
  ...initialState,
  items: [oldHistory, persistedUser, persistedAssistant, optimisticUser],
  historyPrefixCount: 1,
  historyRevision: 6,
};
const rebased = reducer(state, {
  type: "history_rebase",
  items: [
    { kind: "user", id: "history-new", text: "newest persisted question" },
    { kind: "user", id: "persisted-user-durable", text: "persisted question" },
    persistedAssistant,
  ],
  removeIds: ["assistant-live"], // 调用方 replaceRemoveIds 的同 id 分支：页含同 id 行 → 剔 live 副本
  startTurn: 5,
  totalTurns: 7,
  hasOlder: true,
  revision: 7,
  digest: "digest-7",
});
assert.equal(rebased.historyPrefixCount, 3);
assert.equal(rebased.items.filter((item) => item.id === "assistant-live").length, 1, "transcript/live overlap is deduplicated");
assert.equal(rebased.items.find((item) => item.id === "optimistic-user"), optimisticUser, "optimistic user item identity survives rebase");
assert.equal(rebased.historyLayoutRevision, initialState.historyLayoutRevision + 1);

const older = reducer(rebased, {
  type: "history_rebase",
  items: [{ kind: "user", id: "stale", text: "stale" }],
  startTurn: 0,
  totalTurns: 1,
  hasOlder: false,
  revision: 6,
});
assert.equal(older, rebased, "an older transcript revision cannot replace the current projection");

const monotonicProjector = new TurnEventProjector();
monotonicProjector.observeRuntime("monotonic-tab", "epoch-stable", 12, 12, false);
assert.equal(
  monotonicProjector.acceptLive("monotonic-tab", { kind: "turn_started", seq: 1, runtimeEpoch: "epoch-stable" }, "epoch-stable"),
  false,
  "a stale seq=1 event cannot reset a ledger cursor whose sequence is defined to be monotonic",
);

const sessionReplay: TurnEventReplayView = {
  events: [
    {
      turnId: "turn-new-session",
      seq: 1,
      status: "in_progress",
      event: { kind: "turn_started", turnId: "turn-new-session", status: "in_progress" },
    },
    {
      turnId: "turn-new-session",
      seq: 2,
      status: "in_progress",
      event: { kind: "tool_dispatch", turnId: "turn-new-session", tool: { id: "call-ask", name: "ask", readOnly: false } },
    },
    {
      turnId: "turn-new-session",
      seq: 3,
      status: "in_progress",
      event: { kind: "ask_request", turnId: "turn-new-session", ask: { id: "prompt-ask", questions: [] } } as never,
    },
    {
      turnId: "turn-new-session",
      seq: 4,
      status: "in_progress",
      event: { kind: "prompt_answered", turnId: "turn-new-session", itemId: "prompt-ask", status: "in_progress" },
    },
    {
      turnId: "turn-new-session",
      seq: 5,
      status: "in_progress",
      event: {
        kind: "notice",
        turnId: "turn-new-session",
        code: "decision_receipt",
        level: "info",
        text: "Decision recorded: answered",
        decisionReceipt: { id: "prompt-ask", occurrenceId: "receipt-ask", kind: "ask", outcome: "answered" },
      },
    },
    {
      turnId: "turn-new-session",
      seq: 6,
      status: "in_progress",
      event: { kind: "tool_result", turnId: "turn-new-session", tool: { id: "call-ask", name: "ask", readOnly: false, output: "answer" } },
    },
    {
      turnId: "turn-new-session",
      seq: 7,
      status: "in_progress",
      event: { kind: "reasoning", turnId: "turn-new-session", reasoning: "用户选择结束测试。收尾：" },
    },
    {
      turnId: "turn-new-session",
      seq: 8,
      status: "in_progress",
      event: { kind: "message", turnId: "turn-new-session", text: "", reasoning: "用户选择结束测试。收尾：" },
    },
  ],
  floorSeq: 1,
  latestSeq: 8,
  nextAfterSeq: 8,
  hasMore: false,
  resetRequired: false,
  runtimeEpoch: "epoch-stable",
};
binding.TurnEventsForTab = async (_tabId, afterSeq) => {
  assert.equal(afterSeq, 0, "a new session generation replays from its own cursor");
  return sessionReplay;
};
let reboundState = {
  ...initialState,
  items: [
    { kind: "user", id: "u-current", text: "test ask replay" } as const,
    { kind: "assistant", id: "a:turn-new-session:0", text: "", reasoning: "用户选择结束测试。收尾：", streaming: false } as const,
  ],
  activeTurnId: "turn-new-session",
  currentAssistant: "a:turn-new-session:0",
  assistantSegmentOrdinal: 1,
  turnActive: true,
  running: true,
} as ReturnType<typeof reducer>;
const reboundProjector = new TurnEventProjector();
reboundProjector.bind((event) => { reboundState = reducer(reboundState, { type: "event", e: event } as never); });
reboundProjector.bindReplayStart((_tabId, turnId) => {
  reboundState = reducer(reboundState, { type: "replay_turn_rebuild", turnId } as never);
});
reboundProjector.observeRuntime("reused-tab", "epoch-stable", 80, 80, false, undefined, 4);
reboundProjector.observeRuntime("reused-tab", "epoch-stable", 8, 0, true, "turn-new-session", 5);
for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
const askIndex = reboundState.items.findIndex((item) => item.kind === "tool" && item.id === "call-ask");
const receiptIndex = reboundState.items.findIndex((item) => item.kind === "notice" && item.decisionReceipt?.occurrenceId === "receipt-ask");
const thoughtIndex = reboundState.items.findIndex((item) => item.kind === "assistant" && item.reasoning.includes("用户选择结束测试。收尾："));
assert.ok(
  askIndex >= 0 && receiptIndex >= 0 && thoughtIndex >= 0,
  `the session rebind replays the Ask call, receipt, and following thought (${JSON.stringify(reboundState.items.map((item) => ({ kind: item.kind, id: item.id, name: item.kind === "tool" ? item.name : undefined })))})`,
);
assert.ok(askIndex < receiptIndex && receiptIndex < thoughtIndex, "distinct prompt and tool IDs still preserve Ask-before-thought order");
assert.equal(
  reboundProjector.acceptLive("reused-tab", { kind: "text", seq: 9, runtimeEpoch: "epoch-stable", sessionGeneration: 5 }, "epoch-stable"),
  true,
  "new-session live events continue after the rehydrated prefix",
);

let zeroToOneReplayAfter: number | undefined;
const zeroToOneEvents: number[] = [];
const zeroToOneProjector = new TurnEventProjector();
zeroToOneProjector.bind((event) => zeroToOneEvents.push(event.seq ?? 0));
binding.TurnEventsForTab = async (_tabId, afterSeq) => {
  zeroToOneReplayAfter = afterSeq;
  return sessionReplay;
};
zeroToOneProjector.observeRuntime("zero-to-one-tab", "epoch-stable", 80, 80, false);
zeroToOneProjector.observeRuntime("zero-to-one-tab", "epoch-stable", 8, 0, true, "turn-new-session", 1);
for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
assert.equal(zeroToOneReplayAfter, 0, "an omitted generation-zero snapshot resets before generation one replays");
assert.deepEqual(zeroToOneEvents, [1, 2, 3, 4, 5, 6, 7, 8], "generation zero to one replays its lower sequence range");

let resolveOldSessionReplay!: (view: TurnEventReplayView) => void;
let sessionReplayRequests = 0;
binding.TurnEventsForTab = async () => {
  sessionReplayRequests += 1;
  if (sessionReplayRequests === 1) return new Promise<TurnEventReplayView>((resolve) => { resolveOldSessionReplay = resolve; });
  return sessionReplay;
};
const sessionFencedEvents: string[] = [];
const sessionFencedProjector = new TurnEventProjector();
sessionFencedProjector.bind((event) => sessionFencedEvents.push(`${event.turnId}:${event.seq}`));
sessionFencedProjector.observeRuntime("session-fence-tab", "epoch-stable", 8, 0, true, "turn-old-session", 10);
sessionFencedProjector.observeRuntime("session-fence-tab", "epoch-stable", 8, 0, true, "turn-new-session", 11);
for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
resolveOldSessionReplay({
  ...sessionReplay,
  events: [{ turnId: "turn-old-session", seq: 1, status: "in_progress", event: { kind: "text", turnId: "turn-old-session", text: "stale" } }],
  floorSeq: 1,
  latestSeq: 1,
  nextAfterSeq: 1,
});
for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
assert.ok(sessionFencedEvents.length > 0, "the new session replay is projected");
assert.ok(sessionFencedEvents.every((event) => !event.startsWith("turn-old-session:")), "a replay from the prior session generation is discarded");

console.log("turn event projection reset tests passed");
