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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function flushPromises() { return new Promise<void>((resolve) => setTimeout(resolve, 0)); }
async function waitFor(label: string, predicate: () => boolean) {
  for (let i = 0; i < 60; i += 1) {
    await act(async () => { await flushPromises(); });
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function createRig(withSecondTab: boolean) {
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
  let nextFrameId = 0;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const holdFrame = (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    pendingFrames.set(id, callback);
    return id;
  };
  const cancelHeldFrame = (id: number) => { pendingFrames.delete(id); };
  dom.window.requestAnimationFrame = holdFrame;
  dom.window.cancelAnimationFrame = cancelHeldFrame;
  globalThis.requestAnimationFrame = holdFrame;
  globalThis.cancelAnimationFrame = cancelHeldFrame;

  const makeTab = (id: string, active: boolean): TabMeta => ({
    id, scope: "project", workspaceRoot: "/repo", workspaceName: "repo", workspacePath: "/repo",
    topicId: `topic-${id}`, topicTitle: "General", sessionPath: `/repo/sessions/${id}.jsonl`,
    sessionRevision: 1, sessionDigest: `digest-${id}`, turnEventSeq: 50, turnReplayAfterSeq: 50,
    label: "model", ready: true, running: false, mode: "normal", toolApprovalMode: "ask",
    tokenMode: "full", active, cwd: "/repo",
  });
  const tabA = makeTab("tab-page-ahead", true);
  const tabB = makeTab("tab-page-ahead-b", false);
  const tabs = [tabA, ...(withSecondTab ? [tabB] : [])];
  const metas = new Map<string, Meta>(tabs.map((tab) => [tab.id, {
    label: "model", ready: true, eventChannel: "agent:event", sessionPath: tab.sessionPath,
    sessionRevision: 1, sessionDigest: `digest-${tab.id}`, cwd: "/repo", workspaceRoot: "/repo",
    workspaceName: "repo", workspacePath: "/repo", autoApproveTools: false, bypass: false,
    collaborationMode: "normal", toolApprovalMode: "ask", tokenMode: "full", goal: "", goalStatus: "stopped",
  }]));
  const firstPage = deferred<HistorySlice>();
  const eventHandlers: Array<(event: WireEvent) => void> = [];
  const historyCalls = new Map<string, number>();
  window.runtime = {
    EventsOn: (name: string, callback: (...data: unknown[]) => void) => {
      if (name !== "agent:event") return () => {};
      const handler = callback as (event: WireEvent) => void;
      eventHandlers.push(handler);
      return () => {
        const index = eventHandlers.indexOf(handler);
        if (index >= 0) eventHandlers.splice(index, 1);
      };
    },
    BrowserOpenURL: () => {},
  };
  window.go = {
    main: {
      App: {
        ListTabs: async () => tabs.map((tab) => ({ ...tab })),
        MetaForTab: async (id: string) => metas.get(id)!,
        SetActiveTab: async (id: string) => {
          for (const tab of tabs) tab.active = tab.id === id;
        },
        RegisterNavigationIntent: async () => {},
        LatestCompactionForTab: async () => null,
        ContextUsageForTab: async () => ({ used: 0, window: 100, sessionTokens: 0 }),
        EffortForTab: async () => ({ supported: true, current: "auto", default: "auto", levels: ["auto"] }),
        BalanceForTab: async () => ({ available: false, display: "" }),
        JobsForTab: async () => [],
        CheckpointsForTab: async () => [],
        HistorySliceForTab: async (id: string) => {
          const count = (historyCalls.get(id) ?? 0) + 1;
          historyCalls.set(id, count);
          if (id === tabA.id && count === 1) return firstPage.promise;
          return historySliceFromMessages(id, [], { cursor: "", turns: 0 }, { revision: 1, digest: `digest-${id}` });
        },
        HistoryCheckpointTurnsForTab: async () => [],
        ReplayPendingPrompts: async () => {},
      } as Partial<AppBindings> as AppBindings,
    },
  };
  let controller: ReturnType<typeof useController> | undefined;
  function Probe() { controller = useController(); return null; }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(<Probe />); await flushPromises(); });
  await waitFor("initial history request and event subscription", () => historyCalls.get(tabA.id) === 1 && eventHandlers.length > 0);

  const fire = async (event: WireEvent) => {
    await act(async () => {
      for (const handler of eventHandlers) handler(event);
      await flushPromises();
    });
  };
  const flushFrames = async () => {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); await flushPromises(); });
  };
  const assistants = () => (controller?.state.items ?? []).filter((item) => item.kind === "assistant");
  return {
    dom, root, tabA, tabB, firstPage, historyCalls, pendingFrames, fire, flushFrames, assistants,
    controller: () => controller!,
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

console.log("\nsession switch page-ahead repro");

// The page is ahead of consumed deltas. It owns the row id, while the live
// append buffer stays at "hel" until the sequence-next delta arrives.
{
  const rig = await createRig(true);
  const { tabA, tabB } = rig;
  await rig.fire({ kind: "turn_started", tabId: tabA.id, turnId: "turn-a", seq: 51 } as WireEvent);
  await rig.fire({ kind: "stream_attempt", tabId: tabA.id, turnId: "turn-a", seq: 52, streamAttempt: { id: "sa-a", action: "begin", messageId: "msg-a" } } as WireEvent);
  await rig.fire({ kind: "turn_started", tabId: tabB.id, turnId: "turn-b" } as WireEvent);
  await rig.fire({ kind: "stream_attempt", tabId: tabB.id, turnId: "turn-b", streamAttempt: { id: "sa-b", action: "begin", messageId: "msg-b" } } as WireEvent);
  await rig.fire({ kind: "text", tabId: tabA.id, turnId: "turn-a", seq: 53, text: "hel" } as WireEvent);
  await rig.fire({ kind: "text", tabId: tabB.id, turnId: "turn-b", text: "B" } as WireEvent);
  await rig.fire({ kind: "text", tabId: tabB.id, turnId: "turn-b", text: " FIFO" } as WireEvent);
  await rig.fire({ kind: "text", tabId: tabB.id, turnId: "turn-b", text: " pending" } as WireEvent);
  ok(rig.pendingFrames.size > 0, "two tabs both have text waiting for the next animation frame");
  const beforePage = rig.controller().state.historyMutation.seq;
  rig.firstPage.resolve(historySliceFromMessages(tabA.id, [
    { role: "user", content: "write hello" },
    { role: "assistant", id: "msg-a", content: "hello world" },
  ], { cursor: "", turns: 1 }, { revision: 1, digest: `digest-${tabA.id}` }));
  await waitFor("page-ahead hydration", () => rig.controller().state.hydrating === false && rig.controller().state.historyMutation.seq > beforePage);
  ok(rig.assistants().length === 1, "page-ahead history leaves one assistant row");
  ok(rig.assistants()[0]?.id === rig.controller().state.currentAssistant, "live pointer rebinds to the history row");
  ok(rig.controller().state.live?.text === "hel", "page text is not copied into the append-only live buffer");
  ok(rig.controller().liveStore.getSnapshot(tabB.id)?.text === "B FIFO pending" && (rig.historyCalls.get(tabB.id) ?? 0) === 0,
    "hydrating tab A commits tab B's queued text without loading a tab-B page");
  await rig.flushFrames();
  ok(rig.assistants().length === 1 && rig.controller().state.live?.text === "hel", "the delayed frame cannot duplicate or overwrite tab A");
  ok(rig.controller().liveStore.getSnapshot(tabB.id)?.text === "B FIFO pending", "interleaved tab B deltas retain FIFO after the delayed frame");

  await rig.fire({ kind: "text", tabId: tabA.id, turnId: "turn-a", seq: 54, text: "lo world" } as WireEvent);
  await rig.flushFrames();
  await rig.fire({ kind: "turn_phase", tabId: tabA.id, turnId: "turn-a", seq: 55, phase: "checking" } as WireEvent);
  ok(rig.controller().state.live?.text === "hello world", "the sequence-next delta fills the page-ahead suffix exactly once");
  ok(rig.assistants().length === 1, "the page-ahead plus suffix stays in one assistant row");
  await rig.fire({ kind: "message", tabId: tabA.id, turnId: "turn-a", seq: 56, text: "hello world" } as WireEvent);
  await rig.fire({ kind: "turn_done", tabId: tabA.id, turnId: "turn-a", seq: 57 } as WireEvent);
  ok(rig.assistants().length === 1 && rig.assistants()[0]?.text === "hello world", "final message canonicalizes the single row");

  await rig.close();
}

// With no later text delta, the backend's terminal full-message event is the
// canonical handoff and must replace the partial live buffer before turn_done.
{
  const rig = await createRig(false);
  const { tabA } = rig;
  await rig.fire({ kind: "turn_started", tabId: tabA.id, turnId: "turn-canonical", seq: 51 } as WireEvent);
  await rig.fire({ kind: "stream_attempt", tabId: tabA.id, turnId: "turn-canonical", seq: 52, streamAttempt: { id: "sa-canonical", action: "begin", messageId: "msg-canonical" } } as WireEvent);
  await rig.fire({ kind: "text", tabId: tabA.id, turnId: "turn-canonical", seq: 53, text: "hel" } as WireEvent);
  await rig.fire({ kind: "message", tabId: tabA.id, turnId: "turn-canonical", seq: 54, text: "hello world" } as WireEvent);
  const beforePage = rig.controller().state.historyMutation.seq;
  rig.firstPage.resolve(historySliceFromMessages(tabA.id, [
    { role: "user", content: "write hello" },
    { role: "assistant", id: "msg-canonical", content: "hello" },
  ], { cursor: "", turns: 1 }, { revision: 1, digest: `digest-${tabA.id}` }));
  await waitFor("stale page after completed message", () => rig.controller().state.hydrating === false && rig.controller().state.historyMutation.seq > beforePage);
  ok(rig.controller().state.live === undefined, "terminal message has already closed the live buffer");
  ok(rig.assistants().length === 1 && rig.assistants()[0]?.text === "hello world", "a lagging same-ID page cannot roll back completed canonical text");
  await rig.fire({ kind: "turn_done", tabId: tabA.id, turnId: "turn-canonical", seq: 55 } as WireEvent);
  ok(rig.assistants().length === 1 && rig.assistants()[0]?.text === "hello world", "turn completion retains canonical text after the lagging page");
  await rig.close();
}

// A page row with missing optional metadata must not erase the resident row's values.
{
  const rig = await createRig(false);
  const { tabA } = rig;
  await rig.fire({ kind: "turn_started", tabId: tabA.id, turnId: "turn-metadata", seq: 51 } as WireEvent);
  await rig.fire({ kind: "tool_dispatch", tabId: tabA.id, turnId: "turn-metadata", seq: 52, tool: { id: "web-search-a", name: "web_search", args: "{}", readOnly: true } } as WireEvent);
  await rig.fire({ kind: "tool_result", tabId: tabA.id, turnId: "turn-metadata", seq: 53, tool: { id: "web-search-a", name: "web_search", output: '{"sources":[{"title":"Search metadata","url":"https://example.com"}]}' } } as WireEvent);
  await rig.fire({ kind: "stream_attempt", tabId: tabA.id, turnId: "turn-metadata", seq: 54, streamAttempt: { id: "sa-metadata", action: "begin", messageId: "msg-metadata" } } as WireEvent);
  await rig.fire({ kind: "reasoning", tabId: tabA.id, turnId: "turn-metadata", seq: 55, text: "thought" } as WireEvent);
  await rig.fire({
    kind: "message", tabId: tabA.id, turnId: "turn-metadata", seq: 56, text: "answer", reasoning: "thought",
    memoryCitations: [{ id: "citation-a", source: "MEMORY.md", lineStart: 12, note: "kept" }],
  } as WireEvent);
  const resident = rig.assistants()[0];
  ok(resident?.kind === "assistant" && Boolean(resident.workDurationMs) && resident.reasoningDurationMs !== undefined && resident.memoryCitations?.[0]?.id === "citation-a" && resident.searchSources?.[0]?.title === "Search metadata",
    "terminal live row has durations, citations, and search sources before hydration");
  const beforePage = rig.controller().state.historyMutation.seq;
  rig.firstPage.resolve(historySliceFromMessages(tabA.id, [
    { role: "user", content: "write answer" },
    { role: "assistant", id: "msg-metadata", content: "answer" },
  ], { cursor: "", turns: 1 }, { revision: 1, digest: `digest-${tabA.id}` }));
  await waitFor("metadata page hydration", () => rig.controller().state.hydrating === false && rig.controller().state.historyMutation.seq > beforePage);
  const rebased = rig.assistants()[0];
  ok(rebased?.kind === "assistant" && rebased.memoryCitations?.[0]?.id === "citation-a", "page with no citations preserves resident citation metadata");
  ok(rebased?.kind === "assistant" && rebased.workDurationMs === resident?.workDurationMs, "page with no duration preserves resident work duration");
  ok(rebased?.kind === "assistant" && rebased.reasoningDurationMs === resident?.reasoningDurationMs, "page with no reasoning duration preserves resident reasoning duration");
  ok(rebased?.kind === "assistant" && rebased.searchSources?.[0]?.title === "Search metadata", "page with no search sources preserves resident sources");
  await rig.close();
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
