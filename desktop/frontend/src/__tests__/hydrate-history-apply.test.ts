// Run: tsx src/__tests__/hydrate-history-apply.test.ts

import {
  activeTabHydrationPlan,
  canAdoptUnboundLiveSurface,
  duplicateLiveItemIds,
  hasCachedLiveTurn,
  hydratedHistoryApplyMode,
  pageCoveredLiveItemIds,
  sameSessionHydrateIdentity,
  sameSessionPlaceholderItems,
  revisionNotOlder,
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

ok(revisionNotOlder(undefined, 1502) === true, "no expected revision accepts any page");
ok(revisionNotOlder(1501, 1502) === true, "forward revision drift is accepted (a save landed mid-load)");
ok(revisionNotOlder(1501, 1501) === true, "equal revisions are accepted");
ok(revisionNotOlder(1502, 1501) === false, "a revision regression is rejected (rebind/rewind)");
ok(revisionNotOlder(1501, undefined) === true, "an unknown actual revision cannot prove a regression");

// Page-covered terminal rows: frontend-local ids (uN/sN) never match page ids,
// so the id-based removal leaves the optimistic submit / steer notice mounted
// next to the page's own copy of the same message.
const pageUser = (id: string, text: string) => ({ kind: "user", id, text });
const liveUser = (id: string, text: string) => ({ kind: "user", id, text });
const pageNotice = (id: string, text: string) => ({ kind: "notice", id, text });
const liveNotice = (id: string, text: string) => ({ kind: "notice", id, text });

ok(
  pageCoveredLiveItemIds([pageUser("h:7", "inserted mid-turn")], [liveUser("u4", "inserted mid-turn")]).join() === "u4",
  "a page-owned optimistic submit is dropped with its frontend-local id",
);
ok(
  pageCoveredLiveItemIds([pageNotice("h:9", "↪ steer text")], [liveNotice("s3", "↪ steer text")]).join() === "s3",
  "a page-owned steer notice is dropped with its frontend-local id",
);
ok(
  pageCoveredLiveItemIds(
    [pageUser("h:7", "same text")],
    [liveUser("u4", "same text"), liveUser("u5", "same text")],
  ).join() === "u4",
  "count based: a second identical submit keeps its not-yet-persisted row",
);
ok(
  pageCoveredLiveItemIds(
    [pageUser("h:7", "same text"), pageUser("h:9", "same text")],
    [liveUser("u4", "same text"), liveUser("u5", "same text")],
  ).join() === "u4,u5",
  "two page rows cover both live copies",
);
ok(
  pageCoveredLiveItemIds([pageUser("h:7", "persisted")], [liveUser("u4", "not persisted yet")]).length === 0,
  "content the page does not carry keeps its frontend row",
);
ok(
  pageCoveredLiveItemIds([{ kind: "assistant", id: "h:3", text: "half" }], [{ kind: "assistant", id: "a:t1:0", text: "half" }]).length === 0,
  "assistant rows are owned by the turn-level rules, not this cleanup",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
