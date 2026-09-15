// Run: tsx src/__tests__/hydrate-history-apply.test.ts

import {
  activeTabHydrationPlan,
  canAdoptUnboundLiveSurface,
  duplicateLiveItemIds,
  hasCachedLiveTurn,
  hydratedHistoryApplyMode,
  liveOwnedPageTailIds,
  sameSessionHydrateIdentity,
  sameSessionPlaceholderItems,
  shouldPreferResidentHistory,
} from "../lib/hydrateHistoryApply";

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

console.log("\nhydrate history apply");

const mode = hydratedHistoryApplyMode;

ok(mode(true, true, false, { items: [] }) === "skip", "skipHistory blocks apply");
ok(mode(false, false, false, { items: [] }) === "skip", "missing projection blocks apply");
ok(mode(false, true, false, { items: [] }) === "replace", "idle empty surface applies history");
ok(mode(false, true, true, { running: true, items: [] }) === "replace", "running empty surface applies history");
ok(
  mode(false, true, true, { running: true, live: { text: "partial" }, items: [] }) === "replace",
  "a mid-stream surface with no rows yet applies history",
);
ok(
  mode(false, true, true, { running: true, items: [{ kind: "user" }] }) === "prepend",
  "a running turn with no history page behind it gets one prepended",
);
ok(
  mode(false, true, true, { running: true, historyTotalTurns: 3, items: [{ kind: "user" }] }) === "skip",
  "an already-hydrated running transcript is left alone",
);
ok(
  hasCachedLiveTurn({
    running: true,
    historyTotalTurns: 2,
    items: [{ kind: "assistant", streaming: true }],
  }),
  "streaming assistant counts as a cached live turn",
);
ok(
  !hasCachedLiveTurn({ running: true, items: [{ kind: "assistant", streaming: true }] }),
  "a live turn with no history page behind it is not cached",
);
ok(
  duplicateLiveItemIds(
    [{ kind: "user", id: "h1", text: "ask" }],
    [{ kind: "user", id: "l1", text: "ask" }, { kind: "assistant", id: "l2", text: "" }],
  ).join(",") === "l1",
  "a live row the page already carries is dropped",
);
ok(
  duplicateLiveItemIds(
    [{ kind: "user", id: "h1", text: "ask" }],
    [{ kind: "assistant", id: "l2", text: "" }],
  ).length === 0,
  "a live tail the page does not carry is kept",
);
ok(
  sameSessionPlaceholderItems({ sessionPath: "a.jsonl" }, { meta: { sessionPath: "b.jsonl" }, items: [{ kind: "user" }] }) === undefined,
  "foreign session items are not placeholders",
);
ok(
  (sameSessionPlaceholderItems({ sessionPath: "a.jsonl" }, { meta: { sessionPath: "a.jsonl" }, items: [{ kind: "user" }] }) ?? []).length === 1,
  "same-session items stay placeholders",
);
ok(
  sameSessionHydrateIdentity(
    { sessionPath: "a.jsonl", sessionGeneration: 3 },
    { sessionPath: "a.jsonl", sessionGeneration: 3 },
  ),
  "same path and generation prove the same session",
);
ok(
  !sameSessionHydrateIdentity(
    { sessionPath: "a.jsonl", sessionGeneration: 4 },
    { sessionPath: "a.jsonl", sessionGeneration: 3 },
  ),
  "different generations reject placeholders even when paths match",
);
ok(
  !sameSessionHydrateIdentity({ sessionPath: "" }, { sessionPath: "" }),
  "empty identities cannot prove the same session",
);
const sameSessionPlan = activeTabHydrationPlan(
  { sessionPath: "a.jsonl", sessionGeneration: 3, sessionRevision: 8, sessionDigest: "rev-8" },
  { sessionPath: "a.jsonl", sessionGeneration: 3 },
  false,
);
ok(sameSessionPlan.surfacePolicy === "preserve-current", "backend sync preserves a proven same-session surface");
ok(sameSessionPlan.loadOptions.preserveCachedHistory, "same-session backend sync may reuse its resident history");
const reboundPlan = activeTabHydrationPlan(
  { sessionPath: "a.jsonl", sessionGeneration: 4, sessionRevision: 9, sessionDigest: "rev-9" },
  { sessionPath: "a.jsonl", sessionGeneration: 3 },
  false,
);
ok(reboundPlan.surfacePolicy === "replace-surface", "backend sync replaces a generation-rebound surface");
ok(reboundPlan.loadOptions.sessionGeneration === 4, "replace-surface hydration carries the target generation fence");
ok(
  canAdoptUnboundLiveSurface(
    { sessionPath: "a.jsonl", sessionGeneration: 3 },
    undefined,
    { running: true, live: { text: "partial" }, items: [{ kind: "assistant", streaming: true }] },
    true,
  ),
  "an unbound live runtime tail can be adopted before its first metadata snapshot",
);
ok(
  !canAdoptUnboundLiveSurface(
    { sessionPath: "a.jsonl" },
    { sessionPath: "b.jsonl" },
    { running: true, live: { text: "stale" }, items: [{ kind: "assistant", streaming: true }] },
    true,
  ),
  "a differently identified surface cannot be adopted as a live tail",
);
ok(
  !canAdoptUnboundLiveSurface(
    { sessionPath: "a.jsonl" },
    undefined,
    { running: true, historyTotalTurns: 1, hydrateHistoryLoaded: true, items: [{ kind: "assistant", streaming: true }] },
    true,
  ),
  "a surface with persisted history is never adopted without session identity",
);
ok(
  !canAdoptUnboundLiveSurface(
    { sessionPath: "a.jsonl" },
    undefined,
    { running: true, live: { text: "stale epoch" }, items: [{ kind: "assistant", streaming: true }] },
    true,
    "runtime-new",
    "runtime-old",
  ),
  "a mismatched runtime epoch rejects an unbound live tail",
);

ok(
  !shouldPreferResidentHistory(false, false),
  "retry / explicit no-cache hydrates must not serve the resident snapshot",
);
ok(shouldPreferResidentHistory(false, true), "preserveCachedHistory still allows a resident hit");
ok(shouldPreferResidentHistory(false, undefined), "unspecified preserveCachedHistory still allows a resident hit");
ok(!shouldPreferResidentHistory(true, true), "reset hydrates never prefer the resident snapshot");

const liveIdle = {
  items: [{ kind: "user" }, { kind: "assistant" }, { kind: "user" }],
  historyRevision: 10,
  historyDigest: "rev-10",
};
ok(
  mode(false, true, false, liveIdle, {
    items: [{ kind: "user" }],
    revision: 10,
    digest: "rev-10",
  }) === "skip",
  "idle transcript is not replaced by a shorter same-fingerprint resident snapshot",
);
ok(
  mode(false, true, false, liveIdle, {
    items: [{ kind: "user" }, { kind: "assistant" }, { kind: "user" }, { kind: "assistant" }],
    revision: 11,
    digest: "rev-11",
  }) === "replace",
  "a newer backend page still replaces the idle transcript",
);
ok(
  mode(false, true, false, { items: [] }, {
    items: [{ kind: "user" }],
    revision: 10,
    digest: "rev-10",
  }) === "replace",
  "empty idle surface still applies history",
);

// ---- liveOwnedPageTailIds: whole-turn ownership across the two sources -----
// A live assistant row carries no text in `items` (the streaming body lives in
// LiveStream), so per-row signatures cannot align the sources; the user row is
// the only comparable anchor. These lock the turn-level rule and, critically,
// the cases where it must decline to drop anything.
{
  const row = (kind: string, id: string, text: string) => ({ kind, id, text });
  const page = [
    row("user", "h1", "old prompt"),
    row("assistant", "h2", "old answer"),
    row("user", "h3", "new prompt"),
    row("assistant", "h4", "new answer"),
  ];

  ok(
    JSON.stringify(liveOwnedPageTailIds(page, [row("user", "u9", "new prompt"), row("assistant", "a9", "")])) === JSON.stringify(["h3", "h4"]),
    "only the shared tail turn yields to the live surface",
  );
  ok(
    JSON.stringify(liveOwnedPageTailIds(page, [
      row("user", "u1", "old prompt"), row("assistant", "a1", ""),
      row("user", "u9", "new prompt"), row("assistant", "a9", ""),
    ])) === JSON.stringify(["h1", "h2", "h3", "h4"]),
    "consecutive shared turns yield together",
  );
  ok(
    liveOwnedPageTailIds(page, [row("user", "u9", "unrelated prompt"), row("assistant", "a9", "")]).length === 0,
    "a turn the live surface does not hold is never dropped",
  );
  ok(
    liveOwnedPageTailIds(page, [row("user", "u9", ""), row("assistant", "a9", "")]).length === 0,
    "an empty prompt cannot prove a shared turn",
  );
  ok(
    liveOwnedPageTailIds(page, [row("assistant", "a9", "")]).length === 0,
    "a live surface with no turn anchor claims nothing",
  );
  ok(
    liveOwnedPageTailIds([], [row("user", "u9", "new prompt")]).length === 0 &&
      liveOwnedPageTailIds(page, []).length === 0,
    "either side empty claims nothing",
  );
  ok(
    liveOwnedPageTailIds(
      [row("user", "h1", "same prompt")],
      [row("user", "u1", "  same prompt  ")],
    ).length === 1,
    "surrounding whitespace does not defeat the anchor comparison",
  );
  // The two sides reach the transcript by different routes: the page row's text
  // is the user-authored replay content (`RawContent`, or the compose/reference
  // prefixes stripped back off), while the live row carries the composer's
  // display text. For plain text they are byte-identical, which is why the
  // common case aligns. A prompt with added context is NOT the same string on
  // both sides, and the rule must then decline rather than drop a real turn.
  ok(
    liveOwnedPageTailIds(
      [row("user", "h1", "fix the parser")],
      [row("user", "u1", "Referenced context:\n\n<file path=src/parse.ts>…</file>\n\nfix the parser")],
    ).length === 0,
    "an expanded reference preamble on the live side cannot claim the page turn",
  );
  ok(
    liveOwnedPageTailIds(
      [row("user", "h1", "Plan mode: fix the parser")],
      [row("user", "u1", "fix the parser")],
    ).length === 0,
    "a compose-injected prefix on the page side cannot be claimed by the live turn",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
