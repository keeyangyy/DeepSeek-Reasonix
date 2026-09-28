// Run: tsx src/__tests__/subagent-panel.test.tsx
//
// The sub-agent panel renders the session's delegated work outside the
// transcript fold: it lists nested dispatches, marks running ones, and says so
// honestly when a call came from history and has no live preview.

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SubagentPanel } from "../components/SubagentPanel";
import { LocaleProvider } from "../lib/i18n";
import type { SubagentRunView } from "../lib/subagentRunsBridge";
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

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.PointerEvent = dom.window.MouseEvent as unknown as typeof PointerEvent;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as typeof getComputedStyle;

console.log("\nsub-agent panel");

const items: Item[] = [
  { kind: "user", id: "u1", text: "delegate" },
  { kind: "tool", id: "t-fleet", name: "fleet", args: "{}", readOnly: false, status: "running", subject: "audit the fork" },
  {
    kind: "tool", id: "t-sub-1", parentId: "t-fleet", name: "task", args: "{}", readOnly: false, status: "running",
    subject: "check the fold header", profile: { model: "gpt-x", effort: "high" },
    subagentProgress: { phase: "tool", reasoning: "reading files", text: "partial answer", notice: "", lastActivityAt: 0, truncated: false, startedAt: 1, durationMs: 12_500 },
  },
  {
    kind: "tool", id: "t-sub-2", parentId: "t-fleet", name: "read_only_task", args: "{}", readOnly: true, status: "done",
    subagentProgress: { phase: "completed", reasoning: "", text: "", notice: "", lastActivityAt: 0, truncated: false, startedAt: 1, durationMs: 2_000 },
  },
];

async function renderPanel(root: ReturnType<typeof createRoot>, panelItems: Item[], panelRuns?: readonly SubagentRunView[]) {
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SubagentPanel items={panelItems} runs={panelRuns} onClose={() => {}} />
      </LocaleProvider>,
    );
  });
}

const root = createRoot(document.getElementById("root")!);

await renderPanel(root, items);
{
  const container = document.body;
  ok(container.querySelectorAll(".subagent-panel__row").length === 3, "the panel lists the fan-out and both children");
  ok(container.textContent?.includes("audit the fork"), "a dispatch shows its subject");
  ok(container.textContent?.includes("check the fold header"), "a nested child is listed too");
  ok(container.querySelectorAll(".subagent-panel__row[data-running]").length === 2, "running dispatches are marked");
  ok(container.textContent?.includes("3 dispatched"), "the header summarizes the flattened count");
  ok(container.textContent?.includes("2 running"), "the header summarizes the running count");
  // Rows start folded: the detail only appears once the reader expands one.
  ok(!container.textContent?.includes("reading files"), "a folded row hides its live reasoning preview");
  ok(!container.textContent?.includes("gpt-x"), "a folded row hides its dispatch model");
}

// Expanding one row reveals that row's detail only.
{
  // The rows in the DOM are the fan-out followed by its children, so the
  // second title is the child that carries the dispatch model.
  const titles = Array.from(document.querySelectorAll(".subagent-panel__title")) as HTMLButtonElement[];
  const child = titles.find((node) => node.textContent?.includes("check the fold header"));
  await act(async () => { child?.click(); });
  const container = document.body;
  ok(container.textContent?.includes("gpt-x"), "expanding a row shows its dispatch model");
  ok(container.textContent?.includes("check the fold header"), "expanding keeps the fan-out's children visible");
  await act(async () => { child?.click(); });
  ok(!container.textContent?.includes("gpt-x"), "collapsing the row hides its detail again");
  ok(container.textContent?.includes("check the fold header"), "a collapsed fan-out still shows the calls it fanned out");
}

// Running work is grouped above settled work.
{
  await renderPanel(root, [
    { kind: "tool", id: "s-1", name: "task", args: "{}", readOnly: false, status: "done", subject: "finished one" },
    { kind: "tool", id: "s-2", name: "task", args: "{}", readOnly: false, status: "running", subject: "still going" },
  ]);
  const titles = Array.from(document.body.querySelectorAll(".subagent-panel__group-title")).map((node) => node.textContent);
  const rows = Array.from(document.body.querySelectorAll(".subagent-panel__name")).map((node) => node.textContent);
  ok(titles[0] === "Running" && titles[1] === "Finished", "the running group is listed before the settled group");
  ok(rows[0]?.includes("still going"), "the running dispatch comes first regardless of dispatch order");
}

// A running child keeps its whole tree in the running group.
{
  await renderPanel(root, [
    { kind: "tool", id: "c-parent", name: "fleet", args: "{}", readOnly: false, status: "done", subject: "settled orchestrator" },
    { kind: "tool", id: "c-child", parentId: "c-parent", name: "task", args: "{}", readOnly: false, status: "running", subject: "child still working" },
  ]);
  const groups = Array.from(document.body.querySelectorAll(".subagent-panel__group"));
  ok(groups.length === 1, "a tree with a running child is not split across groups");
  ok(groups[0]?.textContent?.includes("settled orchestrator") && groups[0]?.textContent?.includes("child still working"), "the running child keeps its parent in the same group");
  ok(Boolean(document.body.querySelector(".subagent-panel__row[data-running]")), "the running child is still marked");
}

// Sidecar runs the transcript lost are listed and folded like any other row.
{
  await renderPanel(root, [
    { kind: "tool", id: "r-1", name: "use_capability", args: "{}", readOnly: false, status: "done", capabilityId: "tool:fleet" },
  ], [
    { ref: "sa_lost", parentToolCallId: "r-1/fleet-1", kind: "task", name: "task", status: "completed", model: "m-lost" },
  ]);
  const container = document.body;
  ok(container.textContent?.includes("sa_lost") || Boolean(container.querySelector(".subagent-panel__tag")), "a restored sidecar run is listed");
  ok(container.textContent?.includes("2 dispatched"), "the restored run counts toward the summary");
}

// A hydrated call has no live preview: the panel must say so, not invent state.
await renderPanel(root, [
  { kind: "tool", id: "h-1", name: "task", args: "{}", readOnly: false, status: "done", subject: "old call" },
]);
{
  const container = document.body;
  ok(container.textContent?.includes("old call"), "a hydrated call is listed");
  ok(container.textContent?.includes("no live status"), "a hydrated call reports no live phase instead of inventing one");
  ok(!container.querySelector(".subagent-panel__row[data-running]"), "a hydrated settled call is not marked running");
}
// The "no preview" note is row detail, so it appears only after expanding.
{
  const head = document.querySelector(".subagent-panel__row .subagent-panel__title") as HTMLButtonElement | null;
  await act(async () => { head?.click(); });
  ok(document.body.textContent?.includes("No live preview"), "expanding a hydrated call explains the missing preview");
}

await renderPanel(root, [{ kind: "assistant", id: "a1", text: "nothing delegated", reasoning: "", streaming: false }]);
{
  const container = document.body;
  ok(container.textContent?.includes("has not dispatched a sub-agent"), "an empty session shows the empty state");
  ok(container.querySelectorAll(".subagent-panel__row").length === 0, "the empty state lists no rows");
}

await act(async () => { root.unmount(); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
