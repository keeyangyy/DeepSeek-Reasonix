// Run: tsx src/__tests__/clear-session-failure-feedback.test.tsx
//
// Regression for the /clear failure path: a backend clear that fails must
// propagate to the clear-context surface instead of being swallowed, and the
// visible transcript must stay on the backend's real (unchanged) session.

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useController } from "../lib/useController";
import { historySliceFromMessages } from "./mockHistorySlice";
import type { BalanceInfo, CheckpointMeta, ContextInfo, EffortInfo, HistoryMessage, HistorySliceRequest, JobView, Meta, TabMeta, WireEvent } from "../lib/types";

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
  if (actual === expected) {
    ok(true, label);
  } else {
    ok(false, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await flushPromises();
    });
  }
}

function tabMeta(overrides: Partial<TabMeta> = {}): TabMeta {
  return {
    id: "tab-a",
    scope: "project",
    workspaceRoot: "/repo",
    workspaceName: "repo",
    workspacePath: "/repo",
    gitBranch: "main",
    topicId: "topic-a",
    topicTitle: "General",
    label: "model",
    ready: true,
    running: false,
    mode: "normal",
    toolApprovalMode: "ask",
    tokenMode: "full",
    active: true,
    cwd: "/repo",
    ...overrides,
  };
}

function meta(overrides: Partial<Meta> = {}): Meta {
  return {
    label: "model",
    ready: true,
    eventChannel: "agent:event",
    cwd: "/repo",
    workspaceRoot: "/repo",
    workspaceName: "repo",
    workspacePath: "/repo",
    gitBranch: "main",
    autoApproveTools: false,
    bypass: false,
    collaborationMode: "normal",
    toolApprovalMode: "ask",
    tokenMode: "full",
    goal: "",
    goalStatus: "stopped",
    ...overrides,
  };
}

console.log("\nclear session failure feedback");

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

const oldMessages: HistoryMessage[] = [
  { role: "user", content: "old prompt that must survive a failed clear" },
  { role: "assistant", content: "old reply" },
];
const context: ContextInfo = { used: 12, window: 100, sessionTokens: 12 };
const effort: EffortInfo = { supported: true, current: "auto", default: "auto", levels: ["auto"] };
const balance: BalanceInfo = { available: false, display: "" };
const jobs: JobView[] = [];
const checkpoints: CheckpointMeta[] = [];
const eventHandlers: Array<(event: WireEvent) => void> = [];

let clearFailure: Error | null = null;
let clearCalls = 0;
let clearResult = { sessionPath: "/sessions/new.jsonl", sessionRevision: 1, sessionDigest: "digest-new", sessionGeneration: 1 };

window.runtime = {
  EventsOn: (name: string, cb: (...data: unknown[]) => void) => {
    if (name === "agent:event") eventHandlers.push(cb as (event: WireEvent) => void);
    return () => {};
  },
  BrowserOpenURL: () => {},
};
window.go = {
  main: {
    App: {
      RegisterNavigationIntent: async () => {},
      LatestCompactionForTab: async () => null,
      ListTabs: async () => [tabMeta({ sessionPath: "/sessions/old.jsonl", sessionGeneration: 0 })],
      MetaForTab: async () => meta({ sessionPath: "/sessions/old.jsonl", sessionGeneration: 0, runtime: { phase: "ready", epoch: "epoch-1" } }),
      ContextUsageForTab: async () => context,
      EffortForTab: async () => effort,
      BalanceForTab: async () => balance,
      JobsForTab: async () => jobs,
      CheckpointsForTab: async () => checkpoints,
      HistoryForTab: async () => oldMessages,
      HistorySliceForTab: async (tabID: string, req: HistorySliceRequest) => historySliceFromMessages(tabID, oldMessages, req),
      HistoryCheckpointTurnsForTab: async () => [],
      ReplayPendingPrompts: async () => {},
      ReplayPendingPromptsForTab: async () => {},
      ClearSessionForTab: async () => {
        clearCalls += 1;
        if (clearFailure) throw clearFailure;
        return clearResult;
      },
      ClearSession: async () => {
        clearCalls += 1;
        if (clearFailure) throw clearFailure;
        return clearResult;
      },
    },
  },
};

type Controller = ReturnType<typeof useController>;
let controller: Controller | undefined;

function Probe() {
  controller = useController();
  return null;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing root");
const root = createRoot(rootEl);

await act(async () => {
  root.render(<Probe />);
  await flushPromises();
});
await waitFor("active tab", () => controller?.activeTabId === "tab-a");
await waitFor("history hydrated", () => (controller?.state.items.length ?? 0) >= 2);
eq(controller?.state.items.length, 2, "baseline transcript carries the old conversation");

// ── failing clear: the error must reach the caller ────────────────────────
clearFailure = new Error("cannot clear while a turn is running: turn running");
let clearError: unknown;
let clearResolved = false;
await act(async () => {
  try {
    await controller?.clearSession();
    clearResolved = true;
  } catch (err) {
    clearError = err;
  }
  await flushPromises();
});
await settle();

eq(clearCalls, 1, "the clear was actually attempted against the backend");
ok(!clearResolved, "a failed clear must not resolve as if it succeeded");
ok(clearError instanceof Error, "a failed clear surfaces the backend error to the caller");
ok(
  clearError instanceof Error && /turn running/.test(clearError.message),
  "the surfaced error keeps the backend message",
);
eq(controller?.state.items.length, 2, "a failed clear keeps the old transcript visible (backend session is unchanged)");

// ── the failed clear then reports through the decision surface ────────────
const { executeClearSession } = await import("../app-runtime/sessionRuntimeOwner");
const authority = { checkpoint() {}, ownsUI() { return true; } };
let surfaceError: unknown;
let surfaceCompleted = false;
try {
  await executeClearSession(
    { tabId: "tab-a", sessionKey: "tab-a:/sessions/old.jsonl:0" },
    { remote: false },
    {
      clearSession: async () => {
        await controller?.clearSession();
      },
      clearRemoteSession: async () => {},
      retryRemoteHydration: async () => {},
    },
    authority,
  );
  surfaceCompleted = true;
} catch (err) {
  surfaceError = err;
}
ok(!surfaceCompleted, "the clear-context command must not complete when the backend clear failed");
ok(surfaceError instanceof Error, "the clear-context command receives the failure and can warn the user");

// ── a later successful clear still rotates identity and empties the UI ────
clearFailure = null;
clearResult = { sessionPath: "/sessions/new.jsonl", sessionRevision: 7, sessionDigest: "digest-new", sessionGeneration: 5 };
let succeeded = false;
await act(async () => {
  await controller?.clearSession();
  succeeded = true;
  await flushPromises();
});
await settle();
ok(succeeded, "a successful clear still resolves");
eq(controller?.state.items.length, 0, "a successful clear empties the visible transcript");
eq(controller?.state.meta?.sessionPath, "/sessions/new.jsonl", "a successful clear applies the rotated session path");
eq(controller?.state.meta?.sessionGeneration, 5, "a successful clear applies the rotated session generation");

await act(async () => {
  root.unmount();
});
dom.window.close();

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
