// Run: tsx src/__tests__/probe-dispatch-toggle.test.tsx
// 验证队列头部的「暂停派发 / 继续派发」开关：渲染、文案、点击回调。

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

function installDom(language = "zh-CN") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window.navigator, "language", { configurable: true, value: language });
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

const ITEMS: PendingGuidance[] = [
  { id: "q1", text: "第一条排队消息", submitText: "第一条排队消息", state: "queued", intent: "followup" },
  { id: "q2", text: "第二条排队消息", submitText: "第二条排队消息", state: "queued", intent: "followup" },
];

async function render(paused: boolean, onToggle: () => void) {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          draftKey="d1"
          recovery={null}
          recoveryDisabled={false}
          items={ITEMS}
          expanded={false}
          running={false}
          disabled={false}
          readOnly={false}
          sendingId={null}
          paused={paused}
          pausedBusy={false}
          onTogglePaused={onToggle}
          onReview={() => {}}
          onRecoveryResumed={() => {}}
          onRecoveryError={() => {}}
          onToggleExpanded={() => {}}
          onSend={() => {}}
          onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return root;
}

installDom();
console.log("\n派发开关（暂停/继续）组件验证");

// 1. 派发中 → 按钮显示「暂停派发」
{
  const dom = installDom();
  let toggled = 0;
  const root = await render(false, () => { toggled += 1; });
  const btn = document.querySelector<HTMLButtonElement>(".composer-guidance-head__dispatch");
  ok(btn !== null, "派发中：开关渲染在队列头部");
  ok(btn?.textContent?.trim() === "暂停派发", `派发中：按钮文案=暂停派发（实际 ${btn?.textContent?.trim()}）`);
  ok(btn?.getAttribute("aria-pressed") === "false", "派发中：aria-pressed=false");
  ok(btn?.classList.contains("composer-guidance-head__dispatch--paused") === false, "派发中：无 paused 高亮");
  await act(async () => { btn?.click(); });
  ok(toggled === 1, `派发中：点击触发一次 onTogglePaused（实际 ${toggled}）`);
  await act(async () => { root.unmount(); });
  dom.window.close();
}

// 2. 已暂停 → 按钮显示「继续派发」并高亮
{
  const dom = installDom();
  let toggled = 0;
  const root = await render(true, () => { toggled += 1; });
  const btn = document.querySelector<HTMLButtonElement>(".composer-guidance-head__dispatch");
  ok(btn?.textContent?.trim() === "继续派发", `已暂停：按钮文案=继续派发（实际 ${btn?.textContent?.trim()}）`);
  ok(btn?.getAttribute("aria-pressed") === "true", "已暂停：aria-pressed=true");
  ok(btn?.classList.contains("composer-guidance-head__dispatch--paused") === true, "已暂停：有 paused 高亮");
  await act(async () => { btn?.click(); });
  ok(toggled === 1, `已暂停：点击触发一次 onTogglePaused（实际 ${toggled}）`);
  await act(async () => { root.unmount(); });
  dom.window.close();
}

// 3. 忙碌时禁用，避免重复提交
{
  const dom = installDom();
  const rootEl = document.getElementById("root");
  const root = createRoot(rootEl!);
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          draftKey="d1" recovery={null} recoveryDisabled={false} items={ITEMS}
          expanded={false} running={false} disabled={false} readOnly={false} sendingId={null}
          paused={false} pausedBusy onTogglePaused={() => {}} onReview={() => {}}
          onRecoveryResumed={() => {}} onRecoveryError={() => {}} onToggleExpanded={() => {}}
          onSend={() => {}} onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  const btn = document.querySelector<HTMLButtonElement>(".composer-guidance-head__dispatch");
  ok(btn?.disabled === true, "请求在途：按钮禁用");
  await act(async () => { root.unmount(); });
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
