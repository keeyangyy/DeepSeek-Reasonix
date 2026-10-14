// Run: tsx src/__tests__/tool-card-subject.test.tsx

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolCard } from "../components/ToolCard";
import { LocaleProvider } from "../lib/i18n";
import type { Item } from "../lib/useController";

type ToolItem = Extract<Item, { kind: "tool" }>;

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

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
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
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.matchMedia = () => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  return dom;
}

async function renderCard(item: ToolItem, container: HTMLElement) {
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(LocaleProvider, null, React.createElement(ToolCard, { item })));
  });
  return root;
}

console.log("\ncollapsed tool card subject persistence");

{
  const dom = installDom();
  const capabilityId = "mcp-tool:obsidian/search_notes";
  const item: ToolItem = {
    kind: "tool",
    id: "archived-capability",
    name: "use_capability",
    args: "",
    capabilityId,
    readOnly: true,
    status: "done",
    dataArchived: true,
  };
  const firstContainer = document.createElement("div");
  document.body.appendChild(firstContainer);
  const firstRoot = await renderCard(item, firstContainer);
  ok(document.querySelector(".tool__subject")?.textContent === capabilityId, "archived capability ID is visible while initially collapsed");

  await act(async () => firstRoot.unmount());
  firstContainer.remove();
  const reopenedContainer = document.createElement("div");
  document.body.appendChild(reopenedContainer);
  const reopenedRoot = await renderCard(item, reopenedContainer);
  ok(document.querySelector(".tool__subject")?.textContent === capabilityId, "capability ID remains after the outer fold remounts its card");
  await act(async () => reopenedRoot.unmount());
  dom.window.close();
}

{
  const dom = installDom();
  const item: ToolItem = {
    kind: "tool",
    id: "archived-reader",
    name: "read_file",
    args: "",
    capabilityId: "mcp-tool:obsidian/search_notes",
    readOnly: true,
    status: "done",
    dataArchived: true,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = await renderCard(item, container);
  ok(!document.querySelector(".tool__subject"), "capability metadata does not change other tool subjects");
  await act(async () => root.unmount());
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) process.exit(1);
