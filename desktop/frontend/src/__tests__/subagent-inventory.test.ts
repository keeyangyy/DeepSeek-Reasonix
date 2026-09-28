// Run: tsx src/__tests__/subagent-inventory.test.ts
//
// The sub-agent panel's data projection: which calls count as sub-agents, how
// a fan-out nests, and which are still running. Pure function tests — the panel
// view is covered separately.

import { buildSubagentForest, isSubagentItem, summarizeSubagents } from "../lib/subagentInventory";
import type { Item } from "../lib/useController";

let passed = 0;
let failed = 0;

function ok(value: unknown, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

console.log("\nsub-agent inventory projection");

const items: Item[] = [
  { kind: "user", id: "u1", text: "delegate" },
  { kind: "tool", id: "t-read", name: "read_file", args: "{}", readOnly: true, status: "done" },
  { kind: "tool", id: "t-fleet", name: "fleet", args: "{}", readOnly: false, status: "running" },
  {
    kind: "tool", id: "t-sub-1", parentId: "t-fleet", name: "task", args: "{}", readOnly: false, status: "running",
    subject: "audit the parser", profile: { model: "x", effort: "high" },
    subagentProgress: { phase: "tool", reasoning: "", text: "", notice: "", lastActivityAt: 0, truncated: false, startedAt: 1, durationMs: 1_000 },
  },
  {
    kind: "tool", id: "t-sub-2", parentId: "t-fleet", name: "task", args: "{}", readOnly: false, status: "done",
    subagentProgress: { phase: "completed", reasoning: "", text: "", notice: "", lastActivityAt: 0, truncated: false, startedAt: 1, durationMs: 2_000 },
  },
  { kind: "tool", id: "t-orphan", parentId: "t-missing", name: "read_only_task", args: "{}", readOnly: false, status: "done" },
];

{
  const forest = buildSubagentForest(items);
  ok(forest.length === 2, "a fan-out and an orphaned child become the two roots");
  ok(forest[0]?.name === "fleet", "roots keep the transcript's dispatch order");
  ok(forest[0]?.children.length === 2, "the fleet nests the two task children it fanned out");
  ok(forest[1]?.name === "read_only_task", "a child whose parent is missing from the list stays top-level instead of vanishing");

  const summary = summarizeSubagents(forest);
  ok(summary.total === 4, "the summary counts nested children, not just roots");
  ok(summary.running === 2, "only the non-terminal calls count as running (the running fleet and its running child)");

  const running = forest[0]?.children[0];
  ok(running?.phase === "tool" && running.running, "a live phase drives the running flag");
  ok(running?.subject === "audit the parser" && running?.profile?.effort === "high", "the entry carries the dispatch subject and profile");
  const settled = forest[0]?.children[1];
  ok(settled?.running === false, "a terminal phase is not running");
  ok(settled?.durationMs === 2_000, "the progress duration wins over the tool duration");
}

{
  // Hydrated calls have no in-memory progress: the panel must fall back to the
  // tool status rather than reporting everything as running.
  const hydrated: Item[] = [
    { kind: "tool", id: "h-1", name: "task", args: "{}", readOnly: false, status: "done", output: "…" },
    { kind: "tool", id: "h-2", name: "task", args: "{}", readOnly: false, status: "running" },
  ];
  const forest = buildSubagentForest(hydrated);
  ok(forest.length === 2, "hydrated calls without progress still list");
  ok(forest[0]?.phase === undefined, "a hydrated entry reports no phase instead of inventing one");
  ok(summarizeSubagents(forest).running === 1, "the tool status decides the running flag when no phase exists");
}

{
  const plain: Item[] = [
    { kind: "tool", id: "p1", name: "bash", args: "{}", readOnly: false, status: "done" },
    { kind: "assistant", id: "a1", text: "hi", reasoning: "", streaming: false },
  ];
  ok(buildSubagentForest(plain).length === 0, "an ordinary turn yields no sub-agent entries");
  ok(!isSubagentItem(plain[0]!) && !isSubagentItem(plain[1]!), "ordinary tools and messages are not sub-agent dispatches");
  ok(isSubagentItem(items[2]!), "fleet is a sub-agent dispatch");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
