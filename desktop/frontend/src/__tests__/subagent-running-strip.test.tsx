// Run: tsx --import ./scripts/css-stub-register.mjs src/__tests__/subagent-running-strip.test.tsx
//
// The composer-side activity strip: it exists only while a sub-agent runs, names
// what is running, and disappears the moment everything settles.

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SubagentRunningStrip } from "../components/SubagentRunningStrip";
import { LocaleProvider } from "../lib/i18n";
import { buildSubagentForest } from "../lib/subagentInventory";
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

console.log("\nsub-agent running strip");

const root = createRoot(document.getElementById("root")!);

async function renderStrip(items: Item[], onOpen: () => void = () => {}) {
  const forest = buildSubagentForest(items);
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <SubagentRunningStrip forest={forest} onOpen={onOpen} />
      </LocaleProvider>,
    );
  });
}

// Nothing running: the strip renders nothing at all.
await renderStrip([
  { kind: "tool", id: "d-1", name: "task", args: "{}", readOnly: false, status: "done", subject: "finished work" },
]);
ok(!document.body.querySelector(".subagent-strip"), "a settled session renders no strip");

// One running dispatch: the strip names it.
await renderStrip([
  {
    kind: "tool", id: "r-1", name: "task", args: "{}", readOnly: false, status: "running", subject: "live work",
    subagentProgress: { phase: "tool", reasoning: "", text: "", notice: "", lastActivityAt: 0, truncated: false, startedAt: 1, durationMs: 90_000 },
  },
]);
{
  const strip = document.body.querySelector(".subagent-strip");
  ok(Boolean(strip), "a running dispatch renders the strip");
  ok(strip?.textContent?.includes("1 sub-agents running"), "the strip reports the running count");
  ok(strip?.textContent?.includes("live work"), "the strip names the running dispatch");
  ok(strip?.textContent?.includes("1m 30s"), "the strip shows the run's elapsed time");
}

// A running child counts even when its parent settled first.
await renderStrip([
  { kind: "tool", id: "p-1", name: "fleet", args: "{}", readOnly: false, status: "done" },
  { kind: "tool", id: "p-1-child", parentId: "p-1", name: "task", args: "{}", readOnly: false, status: "running", subject: "child live" },
]);
{
  const strip = document.body.querySelector(".subagent-strip");
  ok(Boolean(strip), "a running child alone still renders the strip");
  ok(strip?.textContent?.includes("child live"), "the strip names the running child");
}

// More than the named limit collapses to a "+N more" count.
await renderStrip([
  { kind: "tool", id: "m-1", name: "task", args: "{}", readOnly: false, status: "running", subject: "one" },
  { kind: "tool", id: "m-2", name: "task", args: "{}", readOnly: false, status: "running", subject: "two" },
  { kind: "tool", id: "m-3", name: "task", args: "{}", readOnly: false, status: "running", subject: "three" },
]);
{
  const strip = document.body.querySelector(".subagent-strip");
  ok(strip?.textContent?.includes("3 sub-agents running"), "the strip counts every running dispatch");
  ok(strip?.textContent?.includes("+1 more"), "runs beyond the named limit collapse to a count");
}

// Clicking opens the panel.
{
  let opened = 0;
  await renderStrip([
    { kind: "tool", id: "o-1", name: "task", args: "{}", readOnly: false, status: "running", subject: "clickable" },
  ], () => { opened += 1; });
  const strip = document.body.querySelector(".subagent-strip") as HTMLButtonElement | null;
  await act(async () => { strip?.click(); });
  ok(opened === 1, "clicking the strip opens the panel");
}

await act(async () => { root.unmount(); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
