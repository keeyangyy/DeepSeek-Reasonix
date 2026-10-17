// Run: tsx src/__tests__/reasoning-expansion-policy.test.ts
//
// Pure policy behavior of the three-state reasoning expansion preference:
//   all-collapsed — every inner item (reasoning, tool card, sub-agent
//                   reasoning) starts collapsed; a manual toggle still wins.
//   latest-only   — only the item still producing output is open; a newer
//                   item expands and folds the previous one, and the newest
//                   item may stay expanded once the generation ends.
//   all-expanded  — every inner item starts expanded.
//
// A manual toggle always wins, streaming token updates never flip it back,
// and the Deep experience outranks the policy entirely.

import {
  clearManualOverride,
  defaultReasoningExpansionOpen,
  expansionPreferenceChanged,
  foldSupersededItem,
  reconcileReasoningExpansion,
  withManualToggle,
  type ReasoningExpansionInput,
} from "../lib/reasoningExpansionState";
import type { ReasoningExpansionPolicy } from "../lib/reasoningExpansionPolicy";

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
  ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("\nreasoning expansion policy");

const base: ReasoningExpansionInput = {
  experience: "standard",
  policy: "all-expanded",
  producing: false,
  isLatest: false,
  keepExpandedAfterCompletion: false,
  showWhileRunning: true,
};

const policies: ReasoningExpansionPolicy[] = ["all-collapsed", "latest-only", "all-expanded"];

// ── default open state ───────────────────────────────────────────────────────
{
  const cases: Array<{ policy: ReasoningExpansionPolicy; settled: boolean; latest: boolean; producing: boolean }> = [
    { policy: "all-collapsed", settled: false, latest: false, producing: false },
    { policy: "all-collapsed", settled: false, latest: true, producing: true },
    { policy: "latest-only", settled: false, latest: true, producing: true },
    { policy: "latest-only", settled: false, latest: false, producing: false },
    { policy: "latest-only", settled: true, latest: true, producing: false },
    { policy: "all-expanded", settled: false, latest: false, producing: false },
  ];
  for (const entry of cases) {
    const open = defaultReasoningExpansionOpen({
      ...base,
      policy: entry.policy,
      producing: entry.producing,
      isLatest: entry.latest,
      keepExpandedAfterCompletion: entry.settled,
    });
    if (entry.policy === "all-collapsed") eq(open, false, `${entry.policy} folds an older item`);
    else if (entry.policy === "all-expanded") eq(open, true, `${entry.policy} expands an older item`);
    else eq(open, entry.producing || entry.latest, `${entry.policy} opens only the producing or newest item`);
  }
}

{
  // The newest item stays open after the generation ends, older ones do not.
  const newest = defaultReasoningExpansionOpen({ ...base, policy: "latest-only", isLatest: true, producing: false });
  eq(newest, true, "latest-only keeps the newest item open after generation ends");
  const older = defaultReasoningExpansionOpen({ ...base, policy: "latest-only", isLatest: false, producing: false });
  eq(older, false, "latest-only folds an older item after generation ends");
  const producing = defaultReasoningExpansionOpen({ ...base, policy: "latest-only", producing: true, isLatest: false });
  eq(producing, true, "latest-only opens the item currently producing output");
}

// ── Deep outranks the policy ─────────────────────────────────────────────────
{
  for (const policy of policies) {
    const open = defaultReasoningExpansionOpen({ ...base, policy, experience: "deep", keepExpandedAfterCompletion: true });
    eq(open, true, `deep expands regardless of ${policy}`);
  }
  const deep = reconcileReasoningExpansion(
    { open: true, userOverridden: false, wasProducing: false, wasLatest: false },
    { ...base, policy: "all-collapsed", experience: "deep", keepExpandedAfterCompletion: true },
  );
  eq(deep.open, true, "deep reconcile ignores the collapsed policy");
  const collapsedByHand = reconcileReasoningExpansion(
    { open: false, userOverridden: true, wasProducing: false, wasLatest: false },
    { ...base, policy: "all-collapsed", experience: "deep", keepExpandedAfterCompletion: true },
  );
  eq(collapsedByHand.open, false, "a manual collapse still wins inside deep");
}

// ── streaming token updates never flip a manual choice ───────────────────────
{
  // A user folds the streaming item; every later token frame keeps it folded.
  let state = withManualToggle({ open: true });
  ok(state.userOverridden, "the manual fold is remembered");
  for (let frame = 0; frame < 10; frame += 1) {
    state = reconcileReasoningExpansion(
      { ...state, wasProducing: true, wasLatest: true },
      { ...base, policy: "all-expanded", producing: true, isLatest: true },
    );
  }
  eq(state.open, false, "10 streaming frames do not reopen a manually folded item");
  eq(state.userOverridden, true, "the manual choice stays deliberate across frames");

  // A user expands an older item under latest-only; it stays expanded.
  let expanded = withManualToggle({ open: false });
  for (let frame = 0; frame < 10; frame += 1) {
    expanded = reconcileReasoningExpansion(
      { ...expanded, wasProducing: false, wasLatest: false },
      { ...base, policy: "latest-only", producing: false, isLatest: false },
    );
  }
  eq(expanded.open, true, "a manual expansion survives the latest-only policy");
}

// ── a newer item folds the previous one ──────────────────────────────────────
{
  const superseded = foldSupersededItem({ open: true, userOverridden: false });
  eq(superseded.open, false, "an auto-open previous item folds when a newer one appears");
  const kept = foldSupersededItem({ open: true, userOverridden: true });
  eq(kept.open, true, "a manually opened previous item stays open when a newer one appears");
}

// ── policy / experience changes reset the manual choice ──────────────────────
{
  ok(expansionPreferenceChanged({ experience: "standard", policy: "latest-only" }, { experience: "standard", policy: "all-collapsed" }), "a policy switch is a preference change");
  ok(expansionPreferenceChanged({ experience: "standard", policy: "latest-only" }, { experience: "deep", policy: "latest-only" }), "an experience switch is a preference change");
  ok(!expansionPreferenceChanged({ experience: "standard", policy: "latest-only" }, { experience: "standard", policy: "latest-only" }), "the same preference is not a change");
  const reset = clearManualOverride({ open: false });
  eq(reset.userOverridden, false, "a preference change clears the manual override");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
