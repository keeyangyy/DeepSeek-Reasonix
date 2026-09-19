// Run: tsx src/__tests__/transcript-fold-policy.test.ts
//
// Pure fold-model behavior of the three-mode process fold policy:
//   follow-turn — the running turn's folds stay open, a settled turn folds
//                 (the long-standing default, unchanged)
//   collapsed   — every fold starts closed
//   active-only — only the segment still producing output stays open
// A manual toggle wins over the policy, and Deep always expands, so the
// policy is inert there.

import {
  buildTurnModels,
  defaultFoldOpen,
  foldMapWithToggle,
  foldSegmentStates,
  reconcileFoldEntries,
  EMPTY_FOLDS,
} from "../lib/transcriptRows";
import type { ProcessFoldPolicy } from "../lib/processFoldPolicy";
import type { Item } from "../lib/useController";

let passed = 0;
let failed = 0;

function ok(cond: unknown, label: string) {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}

console.log("\ntranscript process fold policy");

// One running turn split into two segments: an interim answer closed the first
// one, so only the second still produces output.
const runningTurn: Item[] = [
  { kind: "user", id: "u-policy", text: "inspect" },
  { kind: "assistant", id: "a-policy-1", text: "", reasoning: "first thought", streaming: false },
  { kind: "tool", id: "t-policy-1", name: "read_file", args: "{}", readOnly: true, status: "done" },
  { kind: "assistant", id: "a-policy-2", text: "interim answer", reasoning: "", streaming: false },
  { kind: "assistant", id: "a-policy-3", text: "", reasoning: "second thought", streaming: false },
  { kind: "tool", id: "t-policy-2", name: "bash", args: "{}", readOnly: false, status: "running" },
];

const runningModels = buildTurnModels(runningTurn, undefined, true);
const runningStates = foldSegmentStates(runningModels);
const [settledSegment, activeSegment] = runningStates;

// The same turn once it finished: the running tool reports its final status,
// so nothing is producing output anymore.
const settledTurn: Item[] = [
  { kind: "user", id: "u-policy", text: "inspect" },
  { kind: "assistant", id: "a-policy-1", text: "", reasoning: "first thought", streaming: false },
  { kind: "tool", id: "t-policy-1", name: "read_file", args: "{}", readOnly: true, status: "done" },
  { kind: "assistant", id: "a-policy-2", text: "interim answer", reasoning: "", streaming: false },
  { kind: "assistant", id: "a-policy-3", text: "", reasoning: "second thought", streaming: false },
  { kind: "tool", id: "t-policy-2", name: "bash", args: "{}", readOnly: false, status: "done" },
];
const settledStates = foldSegmentStates(buildTurnModels(settledTurn, undefined, false));
eq(runningStates.length, 2, "the running turn yields two fold segments");
eq(settledSegment.selfRunning, false, "the segment closed by an interim answer is not producing output");
eq(settledSegment.turnActive, false, "an earlier segment is not the running turn's last one");
eq(settledSegment.hasRunningWork, true, "every segment of the running turn is turn-level active");
eq(activeSegment.selfRunning, true, "the segment holding the running tool produces output");
eq(activeSegment.turnActive, true, "the last segment of the running turn is turn-active");

{
  const cases: Array<{ policy: ProcessFoldPolicy; open: [boolean, boolean] }> = [
    { policy: "follow-turn", open: [true, true] },
    { policy: "collapsed", open: [false, false] },
    { policy: "active-only", open: [false, true] },
  ];
  for (const entry of cases) {
    const folds = reconcileFoldEntries(EMPTY_FOLDS, runningStates, "standard", false, entry.policy);
    eq(folds?.get(settledSegment.key)?.open, entry.open[0], `${entry.policy}: the settled segment of the running turn`);
    eq(folds?.get(activeSegment.key)?.open, entry.open[1], `${entry.policy}: the active segment of the running turn`);
    eq(defaultFoldOpen(settledSegment, "standard", entry.policy), entry.open[0], `${entry.policy}: defaultFoldOpen agrees with reconcile`);
    eq(defaultFoldOpen(activeSegment, "standard", entry.policy), entry.open[1], `${entry.policy}: defaultFoldOpen agrees for the active segment`);
  }
}

{
  eq(settledStates[0].hasRunningWork, false, "a settled turn clears the turn-level activity");
  eq(settledStates[1].selfRunning, false, "a settled turn clears the segment-level activity");
  for (const policy of ["follow-turn", "collapsed", "active-only"] as const) {
    const folds = reconcileFoldEntries(EMPTY_FOLDS, settledStates, "standard", false, policy);
    eq(folds?.get(settledSegment.key)?.open, false, `${policy}: a completed turn folds its segments`);
    eq(folds?.get(activeSegment.key)?.open, false, `${policy}: a completed turn folds its last segment`);
  }
}

{
  // A segment that settles while the turn keeps running: follow-turn keeps it
  // open (unchanged), active-only folds it as soon as it stops producing.
  const followTurn = reconcileFoldEntries(EMPTY_FOLDS, runningStates, "standard", false, "follow-turn");
  const stillRunning = reconcileFoldEntries(followTurn ?? EMPTY_FOLDS, runningStates, "standard", false, "active-only");
  eq(stillRunning?.get(settledSegment.key)?.open, false, "switching to active-only folds the already-settled segment");
  eq(stillRunning?.get(activeSegment.key)?.open, true, "switching to active-only keeps the producing segment open");

  const reSeeded = reconcileFoldEntries(followTurn ?? EMPTY_FOLDS, runningStates, "standard", true, "collapsed");
  eq(reSeeded?.get(activeSegment.key)?.open, false, "a policy switch re-folds segments already on screen");
  eq(reSeeded?.get(activeSegment.key)?.userOverridden, false, "a policy switch clears manual overrides");
}

{
  // Deep keeps its meaning, so the policy never applies there.
  for (const policy of ["follow-turn", "collapsed", "active-only"] as const) {
    eq(defaultFoldOpen(settledSegment, "deep", policy), true, `deep expands the settled segment regardless of ${policy}`);
    eq(defaultFoldOpen(activeSegment, "deep", policy), true, `deep expands the active segment regardless of ${policy}`);
  }
  const deep = reconcileFoldEntries(EMPTY_FOLDS, runningStates, "deep", false, "collapsed");
  eq(deep?.get(settledSegment.key)?.open, true, "deep reconciles a collapsed policy open");
}

{
  // A manual toggle always wins, including across completion.
  const collapsed = reconcileFoldEntries(EMPTY_FOLDS, runningStates, "standard", false, "collapsed") ?? EMPTY_FOLDS;
  eq(collapsed.get(settledSegment.key)?.open, false, "collapsed seeds the settled segment closed");
  const reopened = foldMapWithToggle(collapsed, settledSegment.key, false);
  // Reconcile returns null when nothing changed, which is also "kept".
  const kept = reconcileFoldEntries(reopened, runningStates, "standard", false, "collapsed") ?? reopened;
  eq(kept.get(settledSegment.key)?.open, true, "a manual expansion survives the collapsed policy");

  const afterCompletion = reconcileFoldEntries(reopened, settledStates, "standard", false, "collapsed") ?? reopened;
  eq(afterCompletion.get(settledSegment.key)?.open, true, "a manual expansion survives the turn completing");
  ok(afterCompletion.get(settledSegment.key)?.userOverridden === true, "the manual choice stays deliberate");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);