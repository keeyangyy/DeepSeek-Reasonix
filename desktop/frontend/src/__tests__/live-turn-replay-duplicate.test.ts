// Run: tsx src/__tests__/live-turn-replay-duplicate.test.ts
//
// Regression: leaving a session that is mid-turn and coming back renders the
// turn's rows a second time.
//
// The backend deliberately replays the ACTIVE turn from its first event:
//   internal/turnevent/ledger.go  ProjectionCursor() -> replayAfter = turnStartSeq - 1
// (TestLedgerProjectionCursorReplaysOnlyActiveTurn pins `active cursor = (3,1)`).
// observeRuntime seeds the projector cursor to that point and replays; the
// reducer applies the replayed events on top of a transcript that ALREADY holds
// everything the turn had produced. Nothing clears the turn being re-projected,
// so the replay appends a parallel copy of it.
//
// The replay range equals the turn's events so far, which is why the symptom is
// "as many duplicates as replies there were before switching away".
//
// Idempotence is the correct criterion: replaying a turn that is already on
// screen must leave the transcript's row count for that turn unchanged. A single
// turn legitimately owns more than one assistant row (a reasoning segment and an
// answer segment), so an absolute row count is not a valid expectation — only
// "the replay added nothing" is.
//
// Drives the projector and the reducer directly (same shape as
// turn-event-projection-reset.test.ts) so the duplicate is visible in state.

import assert from "node:assert/strict";
import type { AppBindings } from "../lib/bridge";
import type { TurnEventReplayView } from "../lib/types";

// The active turn's events, exactly as ProjectionCursor reports them: starting
// at the turn's first event (turnStartSeq).
const replay: TurnEventReplayView = {
  events: [
    {
      turnId: "turn-2",
      seq: 11,
      status: "in_progress",
      event: { kind: "turn_started", turnId: "turn-2", status: "in_progress" },
    },
    {
      turnId: "turn-2",
      seq: 12,
      status: "in_progress",
      event: { kind: "reasoning", turnId: "turn-2", status: "in_progress", reasoning: "用户两个问题：" },
    },
    {
      turnId: "turn-2",
      seq: 13,
      status: "in_progress",
      event: { kind: "tool_dispatch", turnId: "turn-2", status: "in_progress", tool: { id: "tc-1", name: "grep", args: "{}", readOnly: true } },
    },
    {
      turnId: "turn-2",
      seq: 14,
      status: "in_progress",
      event: { kind: "message", turnId: "turn-2", status: "in_progress", text: "先答流程疑问", reasoning: "用户两个问题：" },
    },
  ],
  floorSeq: 11,
  latestSeq: 14,
  nextAfterSeq: 14,
  hasMore: false,
  resetRequired: false,
  runtimeEpoch: "epoch-live",
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

let passed = 0;
let failed = 0;
function ok(value: boolean, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

console.log("\nlive turn replay duplicate");

// ---- the transcript as it stands when the user switches away ----------------
// Turn 1 is complete. Turn 2 is mid-flight: its reasoning segment has settled
// into a row, a tool call is running, and the answer segment is streaming. This
// is the state production holds — abandoning the session never removed it.
const turn2Before = [
  { kind: "assistant", id: "a:turn-2:0", text: "", reasoning: "用户两个问题：", streaming: false, wasStreamed: true, reasoningComplete: true } as const,
  { kind: "tool", id: "tc-1", name: "grep", args: "{}", readOnly: true, status: "running" as const } as const,
  { kind: "assistant", id: "a:turn-2:1", text: "先答流程疑问", reasoning: "用户两个问题：", streaming: true, wasStreamed: true } as const,
];
let state = {
  ...initialState,
  items: [
    { kind: "user", id: "history-1", text: "first question" } as const,
    { kind: "assistant", id: "hist-1-answer", text: "first answer", reasoning: "", streaming: false } as const,
    { kind: "user", id: "u-live", text: "second question" } as const,
    ...turn2Before,
  ],
  historyPrefixCount: 2,
  activeTurnId: "turn-2",
  currentAssistant: "a:turn-2:1",
  turnActive: true,
  running: true,
  // The answer segment is the second one this turn allocated (0 = reasoning).
  assistantSegmentOrdinal: 2,
};

const rowsOf = (items: readonly { kind: string; id: string }[]) =>
  items.filter((item) => item.kind === "assistant" || item.kind === "tool").map((item) => item.id);
const before = rowsOf(state.items);
process.stdout.write(`  [info] turn rows before replay: ${JSON.stringify(before)}\n`);

// ---- replay the active turn, as a switch back does --------------------------
const projected: number[] = [];
const projector = new TurnEventProjector();
projector.bind((event) => {
  projected.push(event.seq ?? 0);
  state = reducer(state, { type: "event", e: event });
});
projector.bindReset(async () => true);
// Mirrors useController: a replay first rewinds the active turn's segment
// allocation so the replayed rows rebuild the turn in place.
projector.bindReplayStart((tabId) => {
  state = reducer(state, { type: "replay_turn_reset" }) as typeof state;
});

// observeRuntime with active=true on an unknown cursor seeds the cursor to the
// active turn's start and replays from there — the switch-back path.
projector.observeRuntime("tab", "epoch-live", 14, 11, true);
for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();

const after = rowsOf(state.items);
process.stdout.write(`  [info] projected seqs: ${JSON.stringify(projected)}\n`);
process.stdout.write(`  [info] turn rows after replay: ${JSON.stringify(after)}\n`);
process.stdout.write(`  [info] items: ${JSON.stringify(state.items.map((i) => ({ kind: i.kind, id: i.id, text: i.kind === "user" || i.kind === "assistant" ? i.text : undefined })), null, 0)}\n`);

ok(projected.length > 0, "the active turn's events are replayed");

// The regression: replaying must not add rows for a turn already on screen.
ok(
  after.length === before.length,
  `replay adds no rows for a turn already rendered (before ${before.length} ${JSON.stringify(before)}, after ${after.length} ${JSON.stringify(after)})`,
);
ok(
  new Set(after).size === after.length,
  `no row id is duplicated after replay (${JSON.stringify(after)})`,
);

// The completed turn is untouched, and nothing already on screen was dropped.
ok(state.items.filter((item) => item.kind === "user" && item.text === "first question").length === 1, "the completed turn is untouched");
ok(state.items.filter((item) => item.kind === "user" && item.text === "second question").length === 1, "the in-flight prompt stays single");
ok(before.every((id) => after.includes(id)), "no existing row was dropped by the replay");

// ---- Variant: the tab's turn flags were already cleared ---------------------
// runtime.rebuilt makes the tab momentarily inactive (cancellable=false), and
// the backend_status that follows clears turnActive/running. A gap replay still
// re-projects the turn in that state, so the reset must not depend on those
// flags being set.
{
  let idleState = {
    ...initialState,
    items: [
      { kind: "user", id: "history-1", text: "first question" } as const,
      { kind: "assistant", id: "hist-1-answer", text: "first answer", reasoning: "", streaming: false } as const,
      { kind: "user", id: "u-live", text: "second question" } as const,
      ...turn2Before,
    ],
    historyPrefixCount: 2,
    activeTurnId: "turn-2",
    currentAssistant: "a:turn-2:1",
    turnActive: false,
    running: false,
    assistantSegmentOrdinal: 2,
  };
  const idleProjector = new TurnEventProjector();
  const idleProjected: number[] = [];
  idleProjector.bind((event) => {
    idleProjected.push(event.seq ?? 0);
    idleState = reducer(idleState, { type: "event", e: event }) as typeof idleState;
  });
  idleProjector.bindReset(async () => true);
  idleProjector.bindReplayStart(() => {
    idleState = reducer(idleState, { type: "replay_turn_reset" }) as typeof idleState;
  });
  idleProjector.observeRuntime("tab-idle", "epoch-live", 14, 11, true);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();

  const idleAfter = rowsOf(idleState.items);
  process.stdout.write(`  [info] (cleared-flags variant) projected: ${JSON.stringify(idleProjected)} rows after: ${JSON.stringify(idleAfter)}\n`);
  ok(idleProjected.length > 0, "the replay still runs when the tab's flags were cleared");
  ok(
    idleAfter.length === before.length,
    `replay adds no rows when the turn flags were cleared first (before ${before.length}, after ${idleAfter.length} ${JSON.stringify(idleAfter)})`,
  );
}

// ---- Variant: a gap repair must NOT rewind the segment allocation ----------
// Only a replay seeded at the active turn's FIRST event rebuilds the whole
// turn. A cursor that already exists means a few missing events are being
// backfilled: rewinding the ordinal there leaves it below the segments already
// on screen, and the next live events reuse a middle segment — new text lands
// mid-transcript while the rows after it stay frozen.
{
  const rewinds: string[] = [];
  const gapProjector = new TurnEventProjector();
  gapProjector.bind(() => {});
  gapProjector.bindReset(async () => true);
  gapProjector.bindReplayStart((tabId) => { rewinds.push(tabId); });

  // First observation: cursor unknown and active → seeded at the turn's start.
  gapProjector.observeRuntime("gap", "epoch", 14, 11, true);
  const afterSeed = rewinds.length;
  // Later observation: cursor already set → a gap backfill, not a rebuild.
  gapProjector.observeRuntime("gap", "epoch", 20, 11, true);

  ok(afterSeed === 1, `a replay seeded at the turn start rewinds once (got ${afterSeed})`);
  ok(rewinds.length === 1, `a gap repair does not rewind the segments again (got ${rewinds.length})`);
}

// ---- Variant: a seq-less delta re-delivered must be dropped ---------------
// Without a seq the cursor cannot recognise a doubled event, so an identical
// kind+body inside the live window counts as a re-delivery.
{
  const dedup = new TurnEventProjector();
  dedup.bind(() => {});
  const first = dedup.acceptLive("dup", { kind: "reasoning", reasoning: "same text" }, "epoch");
  const second = dedup.acceptLive("dup", { kind: "reasoning", reasoning: "same text" }, "epoch");
  const different = dedup.acceptLive("dup", { kind: "reasoning", reasoning: "other text" }, "epoch");
  ok(first === true, "a seq-less delta is accepted");
  ok(second === false, "an identical seq-less delta is dropped as a re-delivery");
  ok(different === true, "a different seq-less delta is still accepted");
}

// ---- Variant: a gap whose cursor predates the active turn must rewind ------
// The "only this session duplicates" case: the cursor was set before the
// active turn started, so the gap replay re-projects the turn's first events
// beside rows already on screen. It must rewind (in place), unlike a backfill
// whose cursor already sits at-or-past the turn start.
{
  const p = new TurnEventProjector();
  const rewinds: string[] = [];
  p.bind(() => {});
  p.bindReset(async () => true);
  p.bindReplayStart((tabId) => rewinds.push(tabId));
  // Cursor set at a completed previous turn (seq 5 == replayAfter), idle.
  p.observeRuntime("gapb", "epoch", 5, 5, true);
  ok(rewinds.length === 0, "an idle completed turn does not rewind");
  // Active turn now starts at seq 6; the cursor (5) predates it; latest grew.
  p.observeRuntime("gapb", "epoch", 14, 6, true);
  ok(rewinds.length === 1, "a gap whose cursor predates the active turn's start rewinds");
}

// ---- Variant: waitForIdle drains a replay that is still paging -------------
// A hydrate must not decide the merge while the active turn is only partly
// re-projected. waitForIdle is a no-op with nothing running and otherwise
// resolves only after the events have been projected.
{
  const idle = new TurnEventProjector();
  idle.bind(() => {});
  let idleSettled = false;
  void idle.waitForIdle("idle-tab").then(() => { idleSettled = true; });
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
  ok(idleSettled, "waitForIdle resolves immediately when no replay is running");

  const projectedSeqs: number[] = [];
  const busy = new TurnEventProjector();
  busy.bind((event) => { projectedSeqs.push(event.seq ?? 0); });
  busy.bindReset(async () => true);
  busy.observeRuntime("busy-tab", "epoch-live", 14, 11, true);
  let idleAfterReplay = false;
  let projectedAtResolve = -1;
  void busy.waitForIdle("busy-tab").then(() => {
    idleAfterReplay = true;
    projectedAtResolve = projectedSeqs.length;
  });
  ok(!idleAfterReplay, "waitForIdle does not resolve while the replay is still running");
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  ok(idleAfterReplay, "waitForIdle resolves once the replay settles");
  ok(projectedAtResolve >= 3, `the replay had projected its events by then (got ${projectedAtResolve})`);
}

// ---- Variant: a cleared transcript replays its turn again ------------------
// A `reset` empties the transcript but the cursor lives outside the reducer, so
// without resetCursor the next runtime snapshot treats those events as already
// projected and the cleared prefix (the in-flight turn) never comes back.
{
  const p = new TurnEventProjector();
  const projectedSeqs: number[] = [];
  const rewinds: string[] = [];
  p.bind((event) => { projectedSeqs.push(event.seq ?? 0); });
  p.bindReset(async () => true);
  p.bindReplayStart((tabId) => rewinds.push(tabId));

  // First observation seeds at the turn start and replays it.
  p.observeRuntime("reset-tab", "epoch-live", 14, 11, true);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  const seeded = projectedSeqs.length;
  ok(seeded > 0, `the first observation replays the turn (got ${seeded})`);

  // The transcript is cleared: dropping the cursor must make the next
  // observation replay the turn again rather than backfill from the old cursor.
  p.resetCursor("reset-tab");
  const beforeSecond = projectedSeqs.length;
  p.observeRuntime("reset-tab", "epoch-live", 14, 11, true);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  const replayed = projectedSeqs.length - beforeSecond;
  ok(replayed === seeded, `a cleared transcript replays the turn again (got ${replayed}, first ${seeded})`);
  ok(rewinds.length === 2, `both replays rewind the turn's segments (got ${rewinds.length})`);

  // Without the cursor drop the same observation only backfills: the cleared
  // prefix would stay gone. This pins the behavior the fix depends on.
  const q = new TurnEventProjector();
  const qSeqs: number[] = [];
  q.bind((event) => { qSeqs.push(event.seq ?? 0); });
  q.bindReset(async () => true);
  q.observeRuntime("keep-tab", "epoch-live", 14, 11, true);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  const qFirst = qSeqs.length;
  q.observeRuntime("keep-tab", "epoch-live", 14, 11, true);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  ok(qSeqs.length === qFirst, "without a cleared transcript the cursor stays and nothing is replayed");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
