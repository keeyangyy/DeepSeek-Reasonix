// 复现：切走切回时，同一轮的 assistant 行在界面上出现两份（v22 步0）
//
// 现场时序：这一轮正在流式输出（live 只画了半截文本）→ 用户切走再切回 →
// 历史页到达，页里带的是这轮的**完整版本**。
// 期望：同一逻辑消息只应存在一份。
// 现状：live 行 id 是 `a:<turnId>:<ordinal>`，页行 id 是 `he:<entryId>`，两者永不相同；
//       且页的文本是 live 的**超集**（不是前缀），"猜"的路子都失效 ⇒ 预期本用例为红。
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppBindings } from "../lib/bridge";
import { useController } from "../lib/useController";
import { historySliceFromMessages } from "./mockHistorySlice";
import type { HistorySlice, Meta, TabMeta, WireEvent } from "../lib/types";

let passed = 0;
let failed = 0;
function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(label: string, predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await flushPromises();
    });
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

console.log("\nsession switch dedup repro");

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
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const tab: TabMeta = {
  id: "tab-repro",
  scope: "project",
  workspaceRoot: "/repo",
  workspaceName: "repo",
  workspacePath: "/repo",
  topicId: "topic-repro",
  topicTitle: "General",
  sessionPath: "/repo/sessions/repro.jsonl",
  sessionRevision: 1,
  sessionDigest: "digest-v1",
  label: "model",
  ready: true,
  running: false,
  mode: "normal",
  toolApprovalMode: "ask",
  tokenMode: "full",
  active: true,
  cwd: "/repo",
};
const meta: Meta = {
  label: "model",
  ready: true,
  eventChannel: "agent:event",
  sessionPath: tab.sessionPath,
  sessionRevision: 1,
  sessionDigest: "digest-v1",
  cwd: "/repo",
  workspaceRoot: "/repo",
  workspaceName: "repo",
  workspacePath: "/repo",
  autoApproveTools: false,
  bypass: false,
  collaborationMode: "normal",
  toolApprovalMode: "ask",
  tokenMode: "full",
  goal: "",
  goalStatus: "stopped",
};

const historyGate = deferred<HistorySlice>();
const eventHandlers: Array<(event: WireEvent) => void> = [];
let historyStarted = false;

window.runtime = {
  EventsOn: (name: string, callback: (...data: unknown[]) => void) => {
    if (name === "agent:event") eventHandlers.push(callback as (event: WireEvent) => void);
    return () => {};
  },
  BrowserOpenURL: () => {},
};
window.go = {
  main: {
    App: {
      LatestCompactionForTab: async () => null,
      ListTabs: async () => [tab],
      MetaForTab: async () => meta,
      ContextUsageForTab: async () => ({ used: 0, window: 100, sessionTokens: 0 }),
      EffortForTab: async () => ({ supported: true, current: "auto", default: "auto", levels: ["auto"] }),
      BalanceForTab: async () => ({ available: false, display: "" }),
      JobsForTab: async () => [],
      CheckpointsForTab: async () => [],
      HistorySliceForTab: async () => {
        historyStarted = true;
        return historyGate.promise;
      },
      HistoryCheckpointTurnsForTab: async () => [],
      ReplayPendingPrompts: async () => {},
    } as Partial<AppBindings> as AppBindings,
  },
};

type Controller = ReturnType<typeof useController>;
let controller: Controller | undefined;
function Probe() {
  controller = useController();
  return null;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing root");
const root = createRoot(rootElement);
await act(async () => {
  root.render(<Probe />);
  await flushPromises();
});
await waitFor("history request", () => historyStarted && eventHandlers.length > 0);

const fire = async (event: WireEvent) => {
  await act(async () => {
    for (const handler of eventHandlers) handler(event);
    await flushPromises();
  });
};
const assistants = () =>
  (controller?.state.items ?? []).filter((item) => item.kind === "assistant");

// 一轮开始，并流出一部分（live 侧文本仍是"半截"）
// 后端在采样前就铸好这条消息的 id，并随 begin 事件下发 —— live 行必须带上它
await fire({ kind: "turn_started", tabId: tab.id } as WireEvent);
await fire({ kind: "stream_attempt", tabId: tab.id, streamAttempt: { id: "sa-1", action: "begin", messageID: "msg-1" } } as WireEvent);
await fire({ kind: "text", tabId: tab.id, text: "hel" } as WireEvent);
ok(assistants().length === 1, "流式期间只有一条 assistant 行");

// 切走再切回：页在 live 之后到达，且页里是这一轮的**完整版本**
historyGate.resolve(
  historySliceFromMessages(
    tab.id,
    [
      { role: "user", content: "write hello" },
      { role: "assistant", id: "msg-1", content: "hello world" },
    ],
    { cursor: "", turns: 1 },
    { revision: 1, digest: "digest-v1" },
  ),
);
await waitFor("hydration completion", () => controller?.state.hydrating === false);

// 核心断言：同一轮的 assistant 只应存在一份（现状预期为红）
ok(
  assistants().length === 1,
  `同一轮 assistant 只应存在一份（实际 ${assistants().length} 份）`,
);
ok(
  (controller?.state.items ?? []).some((item) => item.kind === "user"),
  "页里的 user 行应保留",
);

await act(async () => {
  root.unmount();
});
dom.window.close();

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
