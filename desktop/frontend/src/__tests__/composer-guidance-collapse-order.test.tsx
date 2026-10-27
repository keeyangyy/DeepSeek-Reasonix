// Run: tsx src/__tests__/probe-collapse-order.test.tsx
// 验证折叠时先排序后截断：本轮插话项在存储顺序靠后时仍然可见。

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerGuidanceShelf } from "../components/ComposerGuidanceShelf";
import { LocaleProvider } from "../lib/i18n";
import type { PendingGuidance } from "../components/ComposerGuidanceShelf";

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
  Object.defineProperty(dom.window.navigator, "language", { configurable: true, value: "zh-CN" });
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.InputEvent = dom.window.InputEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.PointerEvent = dom.window.MouseEvent as unknown as typeof PointerEvent;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.ResizeObserver = TestResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true, media: "(prefers-reduced-motion: reduce)", onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  return dom;
}

// 存储顺序：两条后续在前，本轮插话在最后（这正是 AcceptSteer 把项移到队尾后的排列）
const ITEMS: PendingGuidance[] = [
  { id: "f1", text: "候选A", submitText: "候选A", state: "queued", intent: "followup" },
  { id: "f2", text: "候选B", submitText: "候选B", state: "queued", intent: "followup" },
  { id: "s1", text: "本轮A", submitText: "本轮A", state: "steer_accepted", intent: "steer" },
];

async function render(expanded: boolean) {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          draftKey="d1" recovery={null} recoveryDisabled={false} items={ITEMS}
          expanded={expanded} running readOnly={false} disabled={false} sendingId={null}
          paused={false} pausedBusy={false} onTogglePaused={() => {}}
          onReview={() => {}} onRecoveryResumed={() => {}} onRecoveryError={() => {}}
          onToggleExpanded={() => {}} onSend={() => {}} onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return root;
}

function renderedTexts(): string[] {
  return [...document.querySelectorAll(".composer-guidance-item__text")].map((el) => el.textContent?.trim() ?? "");
}

installDom();
console.log("\n折叠截断顺序（先排序后截断）");

// 折叠态：只显示 2 条，但必须是「本轮A + 候选A」，不能把本轮截掉
{
  const dom = installDom();
  const root = await render(false);
  const texts = renderedTexts();
  process.stdout.write(`  折叠渲染 = ${JSON.stringify(texts)}\n`);
  ok(texts.length === 2, `折叠时只显示 2 条（实际 ${texts.length}）`);
  ok(texts[0] === "本轮A", `折叠时本轮项排第一且可见（实际首条 ${texts[0]}）`);
  ok(texts.includes("本轮A"), "折叠时本轮项没有被截掉");
  await act(async () => { root.unmount(); });
  dom.window.close();
}

// 展开态：三条全在，本轮排第一
{
  const dom = installDom();
  const root = await render(true);
  const texts = renderedTexts();
  process.stdout.write(`  展开渲染 = ${JSON.stringify(texts)}\n`);
  ok(texts.length === 3, `展开时显示全部 3 条（实际 ${texts.length}）`);
  ok(texts[0] === "本轮A", `展开时本轮项排第一（实际首条 ${texts[0]}）`);
  await act(async () => { root.unmount(); });
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
