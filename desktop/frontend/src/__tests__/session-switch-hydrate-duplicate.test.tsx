// Run: tsx src/__tests__/session-switch-live-turn-mixup.test.tsx
//
// Regression: a session that is streaming its first turn, left and returned to,
// renders that turn twice — once from the history page the backend just
// persisted (item ids `he:<entryId>`) and once from the live surface that was
// kept across the switch (item ids `u<seq>` / `a:<turnId>`).
//
// The switch-back lands in the `history_prepend` arm of the reducer
// (hydratedHistoryApplyMode returns "prepend" whenever the tab has a live turn
// and no history page behind it yet). The only guard on that arm is
// `duplicateLiveItemIds`, which compares page-row text against live-row text.
// A live assistant row carries no text in `items` — the streaming text lives in
// LiveStream — so the comparison can never match and the page is prepended
// whole, on top of the live copy of the same turn.

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppBindings } from "../lib/bridge";
import { useController } from "../lib/useController";
import { historySliceFromMessages } from "./mockHistorySlice";
import type { HistoryMessage, HistorySliceRequest, Meta, TabMeta, WireEvent } from "../lib/types";

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

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(label: string, predicate: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => { await flushPromises(); });
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

console.log("\nsession switch live turn mixup");

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
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

// ---- fixture ---------------------------------------------------------------
const PROMPT_1 = "first prompt — this one is streaming";
const ANSWER_1 = "the answer that is streaming right now";
const PROMPT_B = "B prompt";
const ANSWER_B = "B answer";

function tabMeta(id: string, active: boolean, sessionPath: string): TabMeta {
  return {
    id,
    scope: "project",
    workspaceRoot: `/repo/${id}`,
    workspaceName: id,
    workspacePath: `/repo/${id}`,
    gitBranch: "main",
    topicId: `topic-${id}`,
    topicTitle: id,
    sessionPath,
    label: `model-${id}`,
    ready: true,
    running: false,
    mode: "normal",
    toolApprovalMode: "ask",
    tokenMode: "full",
    active,
    cwd: `/repo/${id}`,
  };
}

const sessionA = "/repo/tab-a/sessions/tab-a.jsonl";
const sessionB = "/repo/tab-b/sessions/tab-b.jsonl";
const tabA = tabMeta("tab-a", true, sessionA);
const tabB = tabMeta("tab-b", false, sessionB);

function metaFor(tab: TabMeta): Meta {
  return {
    label: tab.label,
    ready: tab.ready,
    eventChannel: "agent:event",
    cwd: tab.cwd || tab.workspaceRoot,
    workspaceRoot: tab.workspaceRoot,
    workspaceName: tab.workspaceName,
    workspacePath: tab.workspacePath,
    sessionPath: tab.sessionPath,
    autoApproveTools: false,
    bypass: false,
    collaborationMode: "normal",
    toolApprovalMode: "ask",
    tokenMode: "full",
    goal: "",
    goalStatus: "stopped",
  };
}

// A opens as a brand-new session with no history page behind it. Its first turn
// is submitted for real, streams over the wire, and the backend persists it
// while the surface is away on B.
let historyA: HistoryMessage[] = [];
const historyB: HistoryMessage[] = [
  { role: "user", content: PROMPT_B },
  { role: "assistant", content: ANSWER_B },
];

let backendActiveId = "tab-a";
const runningTabs = new Set<string>();
const eventHandlers: Array<(event: WireEvent) => void> = [];

function currentTabs(): TabMeta[] {
  return [tabA, tabB].map((tab) => {
    const running = runningTabs.has(tab.id);
    return { ...tab, active: tab.id === backendActiveId, running, cancellable: running };
  });
}

function emit(event: WireEvent) {
  for (const handler of eventHandlers) handler(event);
}

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
      RegisterNavigationIntent: async () => {},
      ListTabs: async () => currentTabs(),
      MetaForTab: async (tabID: string) => metaFor(tabID === "tab-b" ? tabB : tabA),
      ContextUsageForTab: async () => ({ used: 0, window: 100, sessionTokens: 0 }),
      EffortForTab: async () => ({ supported: true, current: "auto", default: "auto", levels: ["auto"] }),
      BalanceForTab: async () => ({ available: false, display: "" }),
      JobsForTab: async () => [],
      CheckpointsForTab: async () => [],
      HistoryForTab: async (tabID: string) => (tabID === "tab-b" ? historyB : historyA),
      HistorySliceForTab: async (tabID: string, req: HistorySliceRequest) =>
        historySliceFromMessages(tabID, tabID === "tab-b" ? historyB : historyA, req, {
          revision: 1,
          digest: `digest-${tabID}-v1`,
        }),
      HistoryCheckpointTurnsForTab: async () => [],
      StartTurnForTab: async (tabID: string) => {
        runningTabs.add(tabID);
        return { turnId: `turn-${tabID}-1`, status: "started" };
      },
      SetActiveTab: async (tabID: string) => { backendActiveId = tabID; },
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

await waitFor("initial hydration of tab A", () => controller?.state.hydrating === false);

function userTexts(): string[] {
  return (controller?.state.items ?? []).filter((item) => item.kind === "user").map((item) => item.text);
}
function assistantTexts(): string[] {
  return (controller?.state.items ?? []).filter((item) => item.kind === "assistant").map((item) => item.text ?? "");
}
function snapshot(label: string) {
  const detail = (controller?.state.items ?? []).map((item) => ({
    kind: item.kind,
    id: item.id,
    text: item.kind === "user" || item.kind === "assistant" ? item.text : undefined,
  }));
  process.stdout.write(`  [info] ${label}: ${JSON.stringify(detail)}\n`);
}

// ---- A streams its first turn ---------------------------------------------
await act(async () => {
  await controller?.sendToTab("tab-a", PROMPT_1);
  await flushPromises();
});
await act(async () => {
  emit({ kind: "turn_started", tabId: "tab-a" });
  emit({ kind: "text", tabId: "tab-a", text: ANSWER_1 });
  await flushPromises();
  await flushPromises();
});
snapshot("streaming on A");
ok(userTexts().filter((text) => text === PROMPT_1).length === 1, "the submitted prompt renders once while streaming");

// The backend persists the in-flight turn while the user is away on B.
historyA = [
  { role: "user", content: PROMPT_1 },
  { role: "assistant", content: ANSWER_1 },
];

// ---- switch A -> B --------------------------------------------------------
await act(async () => {
  await controller?.switchTab("tab-b", currentTabs()[1]);
  await flushPromises();
});
await waitFor("tab B visible", () => userTexts().includes(PROMPT_B));
snapshot("on B");

// ---- switch back B -> A (A is still streaming) ----------------------------
await act(async () => {
  await controller?.switchTab("tab-a", currentTabs()[0]);
  await flushPromises();
  await flushPromises();
});
await waitFor("tab A hydration settles", () => controller?.state.hydrating === false);
await act(async () => { await flushPromises(); });
snapshot("back on A");

const prompt1Count = userTexts().filter((text) => text === PROMPT_1).length;
ok(prompt1Count === 1, `the streaming prompt is rendered exactly once after switching back (got ${prompt1Count})`);
// The live assistant row carries no text in `items` (the streaming body lives in
// LiveStream), so the turn's row count is the observable, not its content.
const streamingAssistantRows = (controller?.state.items ?? []).filter((item) => item.kind === "assistant");
ok(streamingAssistantRows.length === 1, `the streaming turn keeps a single assistant row after switching back (got ${streamingAssistantRows.length})`);
const answer1Count = assistantTexts().filter((text) => text === ANSWER_1).length;
ok(answer1Count === 0, `the page copy of the in-flight answer does not re-appear (got ${answer1Count})`);

// The page's tool/user rows carry `he:` ids; a live row re-basing the same turn
// means the turn is present twice in the transcript projection.
const promptIds = (controller?.state.items ?? [])
  .filter((item) => item.kind === "user" && item.text === PROMPT_1)
  .map((item) => item.id);
ok(promptIds.length === 1, `the streaming turn is owned once, not once per source (ids ${JSON.stringify(promptIds)})`);

await act(async () => { root.unmount(); });
dom.window.close();

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
