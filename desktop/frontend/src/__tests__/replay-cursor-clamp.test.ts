// Run: node --import tsx src/__tests__/replay-cursor-clamp.test.ts
//
// Regression: bde394a11 made acceptLive always (re)register the desired
// replay position. While a repair is in flight that writes pendingRepair at
// the CURRENT cursor — the oldest gap position. The repair's finally then
// re-fires a replay from that stale position, and replayGap used to project
// from the request's afterSeq without clamping to the projector's own cursor,
// so an already-projected interval was projected a second time. The steer
// case appends an unconditional notice row per projection, which rendered the
// duplicate at the transcript bottom (mid-turn steer shown twice).

import assert from "node:assert/strict";
import type { AppBindings } from "../lib/bridge";
import type { TurnEventReplayView } from "../lib/types";

const page: TurnEventReplayView = {
  events: [
    {
      turnId: "turn-a",
      seq: 4,
      status: "in_progress",
      event: { kind: "text", turnId: "turn-a", status: "in_progress", text: "durable" },
    },
    {
      turnId: "turn-a",
      seq: 5,
      status: "in_progress",
      event: { kind: "steer", text: "mid-turn steer" },
    },
  ],
  floorSeq: 1,
  latestSeq: 5,
  nextAfterSeq: 5,
  hasMore: false,
  resetRequired: false,
  runtimeEpoch: "epoch-a",
};

let held: (() => void) | undefined;
let holdNext = false;

const binding: Partial<AppBindings> = {
  TurnEventsForTab: async () => {
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => { held = resolve; });
    }
    return page;
  },
};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: binding as AppBindings } } } as Window,
});

const [{ TurnEventProjector }, { initialState, reducer }] = await Promise.all([
  import("../lib/turnEventProjection"),
  import("../lib/useController"),
]);

const settle = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
};

// --- Projector cursor clamp: a re-fired replay from a stale position must not
// re-project the interval the cursor already covers.
{
  const projected: number[] = [];
  const projector = new TurnEventProjector();
  projector.bind((event) => projected.push(event.seq ?? 0));
  projector.observeRuntime("tab", "epoch-a", 3, 3, true);

  holdNext = true;
  // Gap event: queued, and the in-flight repair starts from cursor 3.
  assert.equal(projector.acceptLive("tab", { kind: "text", text: "live", seq: 6, runtimeEpoch: "epoch-a" }, "epoch-a"), false);
  await settle();
  assert.equal(projected.length, 0, "the first replay is still in flight");

  // A second gap event arrives while that repair is in flight. acceptLive now
  // always registers the desired replay position, writing pendingRepair at the
  // current (stale) cursor 3.
  assert.equal(projector.acceptLive("tab", { kind: "text", text: "live", seq: 8, runtimeEpoch: "epoch-a" }, "epoch-a"), false);

  held?.();
  await settle();
  assert.deepEqual(
    projected,
    [4, 5, 6],
    "the gap interval is projected exactly once (no second projection of 4/5 from the stale re-fire)",
  );
}

// --- Steer projection dedup: the same inbox item must render one notice row
// even when its event is projected twice (replay overlap).
{
  const steerEvent = { kind: "steer", text: "mid-turn steer", itemId: "inbox-1" } as const;
  let state = reducer(initialState, { type: "event", e: steerEvent });
  state = reducer(state, { type: "event", e: steerEvent });
  const notices = state.items.filter(
    (item) => item.kind === "notice" && item.text.includes("mid-turn steer"),
  );
  assert.equal(notices.length, 1, "a re-projected steer renders a single notice row");
}

process.stdout.write("\nreplay cursor clamp tests passed\n");