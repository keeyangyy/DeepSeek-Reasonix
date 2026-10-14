// Run: tsx src/__tests__/session-switch-diagnostics.test.ts

import {
  installSessionSwitchDiagnosticsGlobal,
  noteDedupDrop,
  noteOrderAnomaly,
  noteSwitchPhase,
  noteSwitchStart,
  resetSessionSwitchDiagnostics,
  sessionSwitchSnapshot,
  sessionSwitchSummary,
} from "../lib/sessionSwitchDiagnostics";

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

function eq(actual: unknown, expected: unknown, label: string) {
  ok(actual === expected, `${label}${actual === expected ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

console.log("\nsession switch diagnostics");

// 1. phase timings accumulate with rounded ms
{
  resetSessionSwitchDiagnostics();
  noteSwitchStart();
  noteSwitchPhase("tab-1", "history-load", 12.34);
  noteSwitchPhase("tab-1", "meta", 3.06);
  const snapshot = sessionSwitchSnapshot();
  eq(snapshot.counters.switches, 1, "switch start counted");
  eq(snapshot.switchPhases.length, 2, "two phases recorded");
  eq(snapshot.switchPhases[0]?.ms, 12.3, "phase ms rounded to one decimal");
  eq(snapshot.switchPhases[1]?.ms, 3.1, "second phase ms rounded");
  eq(snapshot.switchPhases[0]?.phase, "history-load", "phase label preserved");
}

// 2. dedup drops count and ignore non-positive counts
{
  resetSessionSwitchDiagnostics();
  noteDedupDrop("tab-1", "rebase", 3, "assistant-row");
  noteDedupDrop("tab-1", "prepend", 0);
  noteDedupDrop("tab-1", "replace", -2);
  const snapshot = sessionSwitchSnapshot();
  eq(snapshot.counters.dedupDrops, 3, "only positive counts accumulate");
  eq(snapshot.dedupEvents.length, 1, "non-positive dedup drops are ignored");
  eq(snapshot.dedupEvents[0]?.kind, "rebase", "dedup kind recorded");
  eq(snapshot.dedupEvents[0]?.count, 3, "dedup count recorded");
}

// 3. order anomalies count
{
  resetSessionSwitchDiagnostics();
  noteOrderAnomaly("tab-2", "compaction-card-before-history");
  noteOrderAnomaly("tab-2", "compaction-card-before-history");
  const snapshot = sessionSwitchSnapshot();
  eq(snapshot.counters.orderAnomalies, 2, "order anomalies counted");
  eq(snapshot.orderEvents.length, 2, "order events recorded");
}

// 4. snapshot is a copy — mutating it does not corrupt the accumulator
{
  resetSessionSwitchDiagnostics();
  noteSwitchPhase("tab-1", "history-load", 5);
  const snapshot = sessionSwitchSnapshot();
  snapshot.switchPhases.push({ at: 0, tabId: "x", phase: "injected", ms: 999 });
  snapshot.counters.switches = 42;
  const fresh = sessionSwitchSnapshot();
  eq(fresh.switchPhases.length, 1, "external mutation does not grow the accumulator");
  eq(fresh.counters.switches, 0, "external mutation does not change counters");
}

// 5. ring buffer caps growth
{
  resetSessionSwitchDiagnostics();
  for (let i = 0; i < 300; i += 1) noteSwitchPhase("tab-1", `phase-${i}`, i);
  const snapshot = sessionSwitchSnapshot();
  eq(snapshot.switchPhases.length, 240, "phase ring buffer capped at 240");
  eq(snapshot.switchPhases[0]?.phase, "phase-60", "oldest phases evicted first");
  eq(snapshot.switchPhases[239]?.phase, "phase-299", "newest phase retained");
}

// 6. reset clears everything
{
  resetSessionSwitchDiagnostics();
  noteSwitchStart();
  noteSwitchPhase("tab-1", "history-load", 9);
  noteDedupDrop("tab-1", "rebase", 2);
  noteOrderAnomaly("tab-1", "ctx");
  resetSessionSwitchDiagnostics();
  const snapshot = sessionSwitchSnapshot();
  eq(snapshot.switchPhases.length, 0, "reset clears phases");
  eq(snapshot.dedupEvents.length, 0, "reset clears dedup events");
  eq(snapshot.orderEvents.length, 0, "reset clears order events");
  eq(snapshot.counters.switches, 0, "reset clears switch counter");
  eq(snapshot.counters.dedupDrops, 0, "reset clears dedup counter");
  eq(snapshot.counters.orderAnomalies, 0, "reset clears order counter");
}

// 7. summary reports counters and the slowest phases
{
  resetSessionSwitchDiagnostics();
  noteSwitchStart();
  noteSwitchPhase("tab-1", "fast", 1);
  noteSwitchPhase("tab-1", "slow", 120);
  noteSwitchPhase("tab-1", "medium", 40);
  const parsed = JSON.parse(sessionSwitchSummary()) as {
    counters: { switches: number };
    slowest: Array<{ phase: string; ms: number }>;
  };
  eq(parsed.counters.switches, 1, "summary carries counters");
  eq(parsed.slowest[0]?.phase, "slow", "summary sorts phases slowest first");
  eq(parsed.slowest[0]?.ms, 120, "summary keeps the slowest ms");
}

// 8. global install exposes snapshot/summary/reset on the host
{
  resetSessionSwitchDiagnostics();
  const host = {} as Window;
  installSessionSwitchDiagnosticsGlobal(host);
  ok(Boolean(host.__reasonixSessionDiagnostics), "global installed");
  noteSwitchPhase("tab-1", "history-load", 7);
  const viaGlobal = host.__reasonixSessionDiagnostics?.snapshot();
  eq(viaGlobal?.switchPhases.length, 1, "global snapshot sees the recorded phase");
  host.__reasonixSessionDiagnostics?.reset();
  eq(sessionSwitchSnapshot().switchPhases.length, 0, "global reset clears the accumulator");
}

// 9. install without a host is a no-op (no window)
{
  let threw = false;
  try {
    installSessionSwitchDiagnosticsGlobal(undefined);
  } catch {
    threw = true;
  }
  ok(!threw, "install without a window does not throw");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
