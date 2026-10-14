// Run: tsx src/__tests__/history-session-rename-ime.test.tsx
// 会话重命名输入框必须对输入法组字期间（composition）的回车免疫：组字回车
// 不关闭编辑器、不提交残缺名；普通回车才提交一次并关闭（上游 e64449816
// 的等价回归测试，适配本仓库的 HistoryPanel）。

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { registerHooks } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionMeta } from "../lib/types";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".svg")) return nextResolve("./asset-stub-for-tests.ts", { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node,
  Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const { LocaleProvider } = await import("../lib/i18n");
const { HistoryPanel } = await import("../components/HistoryPanel");
const root = createRoot(document.getElementById("root")!);
const renamed: string[] = [];
const session: SessionMeta = {
  path: "/sessions/one.jsonl", title: "Old name", preview: "Old name",
  turns: 1, createdAt: Date.now(), lastActivityAt: Date.now(), modTime: Date.now(),
  current: false, open: false,
};

try {
  await act(async () => root.render(<LocaleProvider><HistoryPanel
    sessions={[session]} running={false} onResume={() => {}} onPreview={async () => []}
    onDelete={() => {}} onRename={(_session, title) => renamed.push(title)} onClose={() => {}}
  /></LocaleProvider>));
  await sleep(30);
  const row = document.querySelector(".hist-item");
  assert.ok(row, "history list renders a session row");
  await act(async () => row!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 30 })));
  await sleep(10);
  const rename = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes("Rename"));
  assert.ok(rename, "history context menu offers rename");
  await act(async () => rename!.click());
  await sleep(10);
  const input = document.querySelector<HTMLInputElement>(".hist-item__rename");
  assert.ok(input, "history rename opens an input");
  const composingEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  const safariEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  Object.defineProperty(safariEnter, "keyCode", { value: 229 });
  await act(async () => { input!.dispatchEvent(composingEnter); input!.dispatchEvent(safariEnter); });
  assert.equal(document.querySelector(".hist-item__rename"), input, "IME Enter keeps history rename open");
  assert.deepEqual(renamed, [], "IME Enter does not persist an unfinished name");
  await act(async () => input!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.deepEqual(renamed, ["Old name"], "ordinary Enter commits the name once");
  assert.equal(document.querySelector(".hist-item__rename"), null, "ordinary Enter closes the rename editor");
  console.log("history session rename: IME and ordinary Enter passed");
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}