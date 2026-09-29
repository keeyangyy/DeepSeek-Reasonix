// Run: pnpm exec tsx src/__tests__/subagent-status-strip.test.ts
//
// The status strip reads one source (the persisted run sidecar) and renders the
// backend's precomputed label verbatim. These tests pin that contract: which
// rows count as dispatches, that the strip never composes a label itself, and
// that a settled run drops off.

import { isSubagentDispatchItem, subagentDispatchName } from "../lib/subagentInventory";
import { subagentRunIsRunning } from "../lib/useSubagentRuns";
import type { Item } from "../lib/useController";
import type { SubagentRunView } from "../lib/types";

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

function run(overrides: Partial<SubagentRunView>): SubagentRunView {
  return {
    ref: "sa_1",
    label: "task: 调研上游修复",
    status: "running",
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: "2026-09-29T10:00:00Z",
    ...overrides,
  };
}

function item(overrides: Partial<Extract<Item, { kind: "tool" }>>): Item {
  return {
    kind: "tool", id: "call-1", name: "task", args: "", readOnly: false, status: "running",
    ...overrides,
  } as Item;
}

// A dispatch reaches the transcript either as the direct tool call or wrapped in
// the stable use_capability proxy. Both must count, or one dispatch path would
// fail to refresh the strip.
ok(subagentDispatchName({ name: "task" }) === "task", "a direct task call is a dispatch");
ok(subagentDispatchName({ name: "read_only_task" }) === "read_only_task", "a direct read_only_task call is a dispatch");
ok(subagentDispatchName({ name: "fleet" }) === "fleet", "a direct fleet call is a dispatch");
ok(subagentDispatchName({ name: "use_capability", resolvedName: "task" }) === "task", "a proxied dispatch resolves via resolvedName");
ok(subagentDispatchName({ name: "use_capability", capabilityId: "tool:research" }) === undefined, "an agent profile is not a container dispatch");
ok(isSubagentDispatchItem(item({ name: "use_capability", capabilityId: "tool:research" })), "a proxied agent profile still triggers a re-read");
ok(subagentDispatchName({ name: "use_capability", capabilityId: "tool:read_only_task" }) === "read_only_task", "a proxied read_only_task resolves via capabilityId");
ok(subagentDispatchName({ name: "bash" }) === undefined, "an ordinary tool is not a dispatch");
ok(isSubagentDispatchItem(item({ name: "task" })), "a tool item with a dispatch name counts");
ok(!isSubagentDispatchItem(item({ name: "bash" })), "a bash item does not count");

// The run status decides whether the line exists. A settled run must not be
// reported as running, which is what made the old strip linger after the work
// had finished.
ok(subagentRunIsRunning(run({ status: "running" })), "a running sidecar reports running");
ok(subagentRunIsRunning(run({ status: "queued" })), "a queued sidecar reports running");
ok(!subagentRunIsRunning(run({ status: "completed" })), "a completed run is not running");
ok(!subagentRunIsRunning(run({ status: "failed" })), "a failed run is not running");
ok(!subagentRunIsRunning(run({ status: "interrupted" })), "an interrupted run is not running");

// The label is whatever the backend computed — including its clip — and the
// strip must not re-derive it from anything else.
ok(run({}).label === "task: 调研上游修复", "the strip renders the stored label verbatim");
ok(run({ label: "read_only_task: 极简任务：用 web…" }).label.endsWith("…"), "a clipped backend label arrives already shortened");

process.stdout.write(`\nsubagent status strip: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
