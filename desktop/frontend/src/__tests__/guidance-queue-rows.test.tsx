// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/guidance-queue-rows.test.tsx

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerGuidanceShelf, type PendingGuidance } from "../components/ComposerGuidanceShelf";
import { LocaleProvider } from "../lib/i18n";

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
  if (actual === expected) ok(true, label);
  else ok(false, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.ResizeObserver = TestResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  return dom;
}

// One row per queue state: a follow-up waiting for the next turn, and a steer the
// running turn already accepted.
const rows: PendingGuidance[] = [
  { id: "steer-1", text: "this turn", submitText: "this turn", state: "steer_accepted", intent: "steer" },
  { id: "next-1", text: "next turn a", submitText: "next turn a", state: "queued", intent: "followup" },
  { id: "next-2", text: "next turn b", submitText: "next turn b", state: "queued", intent: "followup" },
];

type Rendered = {
  container: HTMLElement;
  unmount: () => void;
};

async function render(onRelease: (item: PendingGuidance) => void, onSend: (item: PendingGuidance) => void, onMove?: (item: PendingGuidance, toIndex: number) => void): Promise<Rendered> {
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          recovery={null}
          recoveryDisabled={false}
          items={rows}
          expanded
          running
          disabled={false}
          readOnly={false}
          sendingId={null}
          onReview={() => {}}
          onRecoveryResumed={() => {}}
          onRecoveryError={() => {}}
          onToggleExpanded={() => {}}
          onSend={onSend}
          onDismiss={() => {}}
          onEdit={() => {}}
          onRecall={() => {}}
          onMove={onMove}
          onRelease={onRelease}
        />
      </LocaleProvider>,
    );
  });
  return { container, unmount: () => root.unmount() };
}

function rowByText(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll(".composer-guidance-item")].find((row) =>
    row.textContent?.includes(text),
  );
  if (!found) throw new Error(`row not found: ${text}`);
  return found as HTMLElement;
}

function guideButton(row: HTMLElement): HTMLElement {
  const button = row.querySelector(".composer-guidance-item__guide");
  if (!button) throw new Error("guide button missing");
  return button as HTMLElement;
}

installDom();

console.log("\nGuidance queue rows");

// An accepted steer offers the way back to the queue and cannot be dragged:
// reordering a delivered row would promise an order the agent never reads.
{
  const released: string[] = [];
  const sent: string[] = [];
  const view = await render((item) => released.push(item.id), (item) => sent.push(item.id), () => {});
  const steerRow = rowByText(view.container, "this turn");
  eq(guideButton(steerRow).getAttribute("aria-label"), "Move this back to the next-turn queue", "accepted steer offers release");
  ok(!steerRow.querySelector(".composer-guidance-item__grip"), "accepted steer has no drag grip");
  await act(async () => {
    guideButton(steerRow).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  eq(released.join(","), "steer-1", "clicking release calls onRelease");
  eq(sent.length, 0, "release does not submit the row");
  view.unmount();
}

// A next-turn row offers promotion into the running turn and is draggable.
{
  const released: string[] = [];
  const sent: string[] = [];
  const view = await render((item) => released.push(item.id), (item) => sent.push(item.id), () => {});
  const nextRow = rowByText(view.container, "next turn a");
  eq(guideButton(nextRow).getAttribute("aria-label"), "Insert this into the running turn", "next-turn row offers promotion");
  ok(Boolean(nextRow.querySelector(".composer-guidance-item__grip")), "next-turn row has a drag grip");
  await act(async () => {
    guideButton(nextRow).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  eq(sent.join(","), "next-1", "clicking promote calls onSend");
  eq(released.length, 0, "promotion does not release the row");
  view.unmount();
}

// Without an onMove handler the grip disappears even for next-turn rows, so a
// host that cannot reorder never shows a handle that does nothing.
{
  const view = await render(() => {}, () => {});
  const nextRow = rowByText(view.container, "next turn a");
  ok(!nextRow.querySelector(".composer-guidance-item__grip"), "no grip when the host cannot reorder");
  view.unmount();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
