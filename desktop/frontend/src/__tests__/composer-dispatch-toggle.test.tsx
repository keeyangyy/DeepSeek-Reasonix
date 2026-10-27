// Run: tsx src/__tests__/composer-dispatch-toggle.test.tsx
// 验证队列头部的「暂停派发 / 继续派发」开关：渲染、文案、点击调用宿主。

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

function itemsWith(paused: boolean): PendingGuidance[] {
  return [
    { id: "q1", text: "排队消息", submitText: "排队消息", state: "queued", intent: "followup", paused },
  ];
}

// 记录宿主收到的暂停请求
let pauseCalls: boolean[] = [];
function installBridge() {
  (window as unknown as { go: { main: { App: Record<string, unknown> } } }).go = {
    main: {
      App: {
        SetInboxPaused: async (_tabId: string, paused: boolean) => { pauseCalls.push(paused); },
      },
    },
  };
}

async function render(paused: boolean, busy = false) {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          draftKey="d1" tabId="tab-a" recovery={null} recoveryDisabled={false}
          items={itemsWith(paused)} expanded={false} running={false}
          disabled={false} readOnly={false} sendingId={null}
          onReview={() => {}} onRecoveryResumed={() => {}} onRecoveryError={() => {}}
          onToggleExpanded={() => {}} onSend={() => {}} onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  // busy 场景直接读按钮禁用态，由 pauseBusy 内部状态驱动；
  // 为了覆盖禁用分支，这里在点击后立刻观察一次。
  return { root, busy };
}

function button(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".composer-guidance-head__dispatch");
}

installDom();
console.log("\n派发开关（暂停/继续）组件验证");

// 1. 派发中 → 「暂停派发」，点击请求 paused=true
{
  const dom = installDom();
  installBridge();
  pauseCalls = [];
  const { root } = await render(false);
  const btn = button();
  ok(btn !== null, "派发中：开关渲染在队列头部");
  ok(btn?.textContent?.trim() === "暂停派发", `派发中：文案=暂停派发（实际 ${btn?.textContent?.trim()}）`);
  ok(btn?.getAttribute("aria-pressed") === "false", "派发中：aria-pressed=false");
  await act(async () => { btn?.click(); await new Promise((r) => setTimeout(r, 0)); });
  ok(pauseCalls.length === 1 && pauseCalls[0] === true, `派发中：点击请求暂停（实际 ${JSON.stringify(pauseCalls)}）`);
  await act(async () => { root.unmount(); });
  dom.window.close();
}

// 2. 已暂停 → 「继续派发」并高亮，点击请求 paused=false
{
  const dom = installDom();
  installBridge();
  pauseCalls = [];
  const { root } = await render(true);
  const btn = button();
  ok(btn?.textContent?.trim() === "继续派发", `已暂停：文案=继续派发（实际 ${btn?.textContent?.trim()}）`);
  ok(btn?.getAttribute("aria-pressed") === "true", "已暂停：aria-pressed=true");
  ok(btn?.classList.contains("composer-guidance-head__dispatch--paused") === true, "已暂停：有 paused 高亮");
  await act(async () => { btn?.click(); await new Promise((r) => setTimeout(r, 0)); });
  ok(pauseCalls.length === 1 && pauseCalls[0] === false, `已暂停：点击请求继续（实际 ${JSON.stringify(pauseCalls)}）`);
  await act(async () => { root.unmount(); });
  dom.window.close();
}

// 3. 请求在途时按钮禁用，避免重复提交
{
  const dom = installDom();
  installBridge();
  pauseCalls = [];
  const rootEl = document.getElementById("root");
  const root = createRoot(rootEl!);
  let release: (() => void) | null = null;
  (window as unknown as { go: { main: { App: Record<string, unknown> } } }).go.main.App.SetInboxPaused = (_t: string, paused: boolean) => new Promise<void>((resolve) => {
    pauseCalls.push(paused);
    release = resolve;
  });
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ComposerGuidanceShelf
          draftKey="d1" tabId="tab-a" recovery={null} recoveryDisabled={false}
          items={itemsWith(false)} expanded={false} running={false}
          disabled={false} readOnly={false} sendingId={null}
          onReview={() => {}} onRecoveryResumed={() => {}} onRecoveryError={() => {}}
          onToggleExpanded={() => {}} onSend={() => {}} onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  const btn = button();
  await act(async () => { btn?.click(); await new Promise((r) => setTimeout(r, 0)); });
  ok(button()?.disabled === true, "请求在途：按钮禁用");
  await act(async () => { release?.(); await new Promise((r) => setTimeout(r, 0)); });
  ok(button()?.disabled === false, "请求完成：按钮恢复可用");
  await act(async () => { root.unmount(); });
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
