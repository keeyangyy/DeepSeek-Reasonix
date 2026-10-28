// 回归保护：InboxChanged 的会话作用域判定。
//
// 背景：Composer 用 inboxSessionPath 推导 inboxSessionKey，再用它过滤
// InboxChanged 事件。App 层曾漏传这个 prop，导致 inboxSessionKey 退化成
// 项目级 workspaceScopeKey，与事件里的会话文件路径永不匹配 —— 所有事件
// 被静默丢弃，队列只能靠重新挂载（重新拉快照）才更新。
//
// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/composer-inbox-scope-refresh.test.tsx

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../components/Composer";
import { LocaleProvider } from "../lib/i18n";
import { ToastProvider } from "../lib/toast";

const TAB_ID = "tab-a";
const SESSION_A = "/sessions/a.jsonl";
const SESSION_B = "/sessions/b.jsonl";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
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

type InboxItem = {
  id: string; intent: string; state: string; revision: number;
  preview: string; byteSize: number; source: string; position: number;
};

let listeners: Array<(payload?: unknown) => void> = [];
let snapshotItems: InboxItem[] = [];
let snapshotRevision = 0;
let snapshotPath = SESSION_A;

function snapshot() {
  return {
    revision: snapshotRevision, paused: false, recovered: false, recoveredCount: 0,
    sessionPath: snapshotPath,
    items: snapshotItems, itemsCount: snapshotItems.length,
    bytes: snapshotItems.length * 64, maxItems: 64, maxBytes: 64 * 1024 * 1024,
  };
}

function installBridge() {
  listeners = [];
  (window as unknown as { runtime: unknown }).runtime = {
    EventsOn(channel: string, cb: (payload?: unknown) => void) {
      if (channel === "InboxChanged") listeners.push(cb);
      return () => {};
    },
  };
  (window as unknown as { go: unknown }).go = {
    main: {
      App: {
        Commands: async () => [], Models: async () => [], ModelsForTab: async () => [],
        ListDir: async () => [], ListDirForTab: async () => [],
        SearchFileRefs: async () => [], SearchFileRefsForTab: async () => [],
        ListTabs: async () => [{ id: TAB_ID, turnId: "turn-1" }],
        InboxSnapshot: async () => snapshot(),
        ReadInboxItem: async () => ({ displayText: "", submitText: "" }),
        ReleaseInboxItem: async () => {},
        SetInboxPaused: async () => {},
      },
    },
  };
}

function rows(): string[] {
  return [...document.querySelectorAll(".composer-guidance-item__text")].map((el) => el.textContent?.trim() ?? "");
}

async function fire(revision: number, sessionPath: string) {
  await act(async () => {
    for (const listener of listeners) listener({ tabId: TAB_ID, sessionPath, revision });
    await flush();
    await flush();
  });
}

async function renderWith(opts: { inboxSessionPath?: string }) {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  const props = {
    running: true,
    collaborationMode: "normal" as never,
    toolApprovalMode: "ask" as never,
    goal: "", cwd: "/repo", modelLabel: "DeepSeek-R1",
    tabId: TAB_ID, sessionKey: "session-a",
    inboxSessionPath: opts.inboxSessionPath,
    onSend: () => {},
    onCancel: async () => ({ discardedItemIds: [] }),
    onCycleMode: () => {}, onSetMode: () => {}, onSetCollaborationMode: () => {},
    onSetToolApprovalMode: () => {}, onToggleYoloApprovalMode: () => {}, onClearGoal: () => {},
    onSwitchModel: () => {}, onSetEffort: () => {},
    ready: true,
  };
  await act(async () => {
    root.render(<LocaleProvider><ToastProvider><Composer {...props} /></ToastProvider></LocaleProvider>);
    await flush();
  });
  return root;
}

async function main() {
  installDom();
  installBridge();

  // 场景 1：传了 inboxSessionPath，事件带同一路径 —— 必须刷新。
  snapshotItems = [
    { id: "g1", intent: "followup", state: "queued", revision: 2, preview: "待派发一", byteSize: 64, source: "desktop", position: 1 },
    { id: "g2", intent: "followup", state: "queued", revision: 3, preview: "待派发二", byteSize: 64, source: "desktop", position: 2 },
  ];
  snapshotRevision = 4;
  snapshotPath = SESSION_A;

  let root = await renderWith({ inboxSessionPath: SESSION_A });
  ok(rows().length === 2, `初始渲染出两条排队（实际 ${JSON.stringify(rows())}）`);

  // 后端派发完毕：队列清空，revision 前进
  snapshotItems = [];
  snapshotRevision = 9;
  await fire(9, SESSION_A);
  ok(rows().length === 0, `同会话的 InboxChanged 能清空队列（实际 ${rows().length} 行）`);

  await act(async () => { root.unmount(); });

  // 场景 2：事件来自别的会话 —— 必须忽略，不能污染当前会话。
  snapshotItems = [
    { id: "h1", intent: "followup", state: "queued", revision: 12, preview: "别的会话", byteSize: 64, source: "desktop", position: 1 },
  ];
  snapshotRevision = 13;
  snapshotPath = SESSION_B;

  root = await renderWith({ inboxSessionPath: SESSION_A });
  await fire(13, SESSION_B);
  ok(rows().length === 0, `别的会话的 InboxChanged 被忽略（实际 ${rows().length} 行）`);

  // 同一会话再发一次，确认仍能刷新（守卫没有把自己锁死）
  snapshotRevision = 14;
  snapshotPath = SESSION_A;
  await fire(14, SESSION_A);
  ok(rows().length === 1, `同会话事件随后能刷新（实际 ${rows().length} 行）`);

  await act(async () => { root.unmount(); });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
