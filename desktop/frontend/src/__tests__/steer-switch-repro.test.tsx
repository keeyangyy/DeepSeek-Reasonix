// Run: npx tsx src/__tests__/steer-switch-repro.test.tsx
//
// 竞态回放：把「流式进行中」与「切换/插入消息/工具/ask」交错起来，检查历史页
// 合并后思考块是否错位或重复。现场形态取自 diagnose dcd768d4 与真实会话
// （assistant content 为空 + toolCalls + 长 reasoning，steer notice 夹在轮次之间）。
//
// 每个场景都断言用户可见结果：assistant 段数、每段 reasoning 的首句、工具不重复。
// 断言同时是回归护栏——任何场景变红都说明该交错路径出现了错位。

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppBindings } from "../lib/bridge";
import { useController } from "../lib/useController";
import { historySliceFromMessages } from "./mockHistorySlice";
import { partitionTurnItems } from "../lib/transcriptRows";
import type { HistoryMessage, Meta, TabMeta, WireEvent } from "../lib/types";

let passed = 0;
let failed = 0;
function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}
function flushPromises() { return new Promise<void>((resolve) => setTimeout(resolve, 0)); }
async function waitFor(label: string, predicate: () => boolean) {
  for (let i = 0; i < 80; i += 1) {
    await act(async () => { await flushPromises(); });
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const STEER = "你可以看完后可以再围绕一下，围绕这个主干，整个循环";
/** notice 正文是 `↪ <用户原文>`，不含 "steer" 字样，用它定位 steer 行。 */
const STEER_MARK = "你可以看完后";

/** 真实形态：同一 turn 内三段无正文的工具轮，中间夹一条 steer notice。 */
function historyRows(): HistoryMessage[] {
  return [
    { role: "user", content: "每个包有文档或者介绍吗？可以都看一下吗？" },
    { role: "assistant", id: "m1", content: "", reasoning: "用户问：每个包有文档或者介绍吗？" },
    { role: "tool", content: "d1", toolCallId: "callA1", name: "bash" },
    { role: "tool", content: "d2", toolCallId: "callA2", name: "bash" },
    { role: "notice", level: "info", content: "↪ " + STEER },
    { role: "assistant", id: "m2", content: "", reasoning: "用户 steer：看完包介绍后，围绕主干" },
    { role: "tool", content: "d3", toolCallId: "callB1", name: "bash" },
    { role: "assistant", id: "m3", content: "", reasoning: "继续拿剩余空 doc 包" },
    { role: "tool", content: "d4", toolCallId: "callC1", name: "bash" },
    { role: "assistant", id: "m4", content: "好，现在写回复。", reasoning: "" },
  ] as HistoryMessage[];
}

type Rig = Awaited<ReturnType<typeof createRig>>;

async function createRig(options: { deferPage?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: "http://localhost/",
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

  const pendingFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  const holdFrame = (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    pendingFrames.set(id, callback);
    return id;
  };
  dom.window.requestAnimationFrame = holdFrame;
  dom.window.cancelAnimationFrame = (id: number) => { pendingFrames.delete(id); };
  globalThis.requestAnimationFrame = holdFrame;
  globalThis.cancelAnimationFrame = (id: number) => { pendingFrames.delete(id); };

  const makeTab = (id: string, active: boolean): TabMeta => ({
    id, scope: "project", workspaceRoot: "/repo", workspaceName: "repo", workspacePath: "/repo",
    topicId: `topic-${id}`, topicTitle: "General", sessionPath: `/repo/sessions/${id}.jsonl`,
    sessionRevision: 1, sessionDigest: `digest-${id}`, turnEventSeq: 50, turnReplayAfterSeq: 50,
    label: "model", ready: true, running: false, mode: "normal", toolApprovalMode: "ask",
    tokenMode: "full", active, cwd: "/repo",
  });
  const tabA = makeTab("tab-a", true);
  const tabB = makeTab("tab-b", false);
  const tabs = [tabA, tabB];
  const metas = new Map<string, Meta>(tabs.map((tab) => [tab.id, {
    label: "model", ready: true, eventChannel: "agent:event", sessionPath: tab.sessionPath,
    sessionRevision: 1, sessionDigest: `digest-${tab.id}`, cwd: "/repo", workspaceRoot: "/repo",
    workspaceName: "repo", workspacePath: "/repo", autoApproveTools: false, bypass: false,
    collaborationMode: "normal", toolApprovalMode: "ask", tokenMode: "full", goal: "", goalStatus: "stopped",
  }]));

  // 页面内容可在场景中改写；deferPage 让首次页面滞留，制造「流式跑到一半页面才到」。
  const pageState: { messages: HistoryMessage[] } = { messages: [] };
  const gated = options.deferPage ? deferred<HistoryMessage[]>() : undefined;
  const eventHandlers: Array<(event: WireEvent) => void> = [];
  const historyCalls = new Map<string, number>();
  window.runtime = {
    EventsOn: (name: string, callback: (...data: unknown[]) => void) => {
      if (name !== "agent:event") return () => {};
      const handler = callback as (event: WireEvent) => void;
      eventHandlers.push(handler);
      return () => { const i = eventHandlers.indexOf(handler); if (i >= 0) eventHandlers.splice(i, 1); };
    },
    BrowserOpenURL: () => {},
  };
  window.go = {
    main: {
      App: {
        ListTabs: async () => tabs.map((tab) => ({ ...tab })),
        MetaForTab: async (id: string) => metas.get(id)!,
        SetActiveTab: async (id: string) => { for (const tab of tabs) tab.active = tab.id === id; },
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
          const messages = id === tabA.id ? pageState.messages : [];
          const digest = `digest-${id}-${messages.length}`;
          if (gated && id === tabA.id && count === 1) {
            const slice = historySliceFromMessages(id, await gated.promise, { cursor: "", turns: 0 }, { revision: 1, digest });
            return slice;
          }
          return historySliceFromMessages(id, messages, { cursor: "", turns: 0 }, { revision: 1, digest });
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

  const flushFrames = async () => {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); await flushPromises(); });
  };
  const fire = async (event: WireEvent) => {
    await act(async () => {
      for (const handler of eventHandlers) handler(event);
      await flushPromises();
    });
    await flushFrames();
  };
  const settle = async () => {
    await act(async () => { for (let i = 0; i < 20; i += 1) await flushPromises(); });
    await flushFrames();
  };
  const switchTo = async (id: string) => {
    await act(async () => { await controller!.switchTab(id); await flushPromises(); });
    await settle();
  };
  const reasoningOf = () => (controller?.state.items ?? [])
    .filter((item) => item.kind === "assistant")
    .map((item) => String((item as { reasoning?: string }).reasoning ?? ""));
  const toolIds = () => (controller?.state.items ?? [])
    .filter((item) => item.kind === "tool")
    .map((item) => String((item as { id?: string }).id ?? ""));

  return {
    dom, root, tabA, tabB, pageState, gated, historyCalls, fire, settle, switchTo,
    reasoningOf, toolIds,
    controller: () => controller!,
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

// ── 公共事件片段 ────────────────────────────────────────────────────────────
const begin = (tab: string, turn: string, attempt: string, messageId: string, seq: number): WireEvent =>
  ({ kind: "stream_attempt", tabId: tab, turnId: turn, seq, streamAttempt: { id: attempt, action: "begin", messageId } } as WireEvent);
const reasoning = (tab: string, turn: string, seq: number, text: string): WireEvent =>
  ({ kind: "reasoning", tabId: tab, turnId: turn, seq, text } as WireEvent);
const toolCall = (tab: string, turn: string, seq: number, id: string): WireEvent[] => [
  { kind: "tool_dispatch", tabId: tab, turnId: turn, seq, tool: { id, name: "bash", args: "{}", readOnly: true } } as WireEvent,
  { kind: "tool_result", tabId: tab, turnId: turn, seq: seq + 1, tool: { id, name: "bash", output: "result-" + id } } as WireEvent,
];

/** 断言一套「同一 turn、三段思考、steer 在第二段之前」的可见结果。 */
function assertStreamedOrder(rig: Rig, label: string) {
  const segments = rig.reasoningOf();
  const joined = segments.join(" | ");
  ok(segments.length >= 3, `${label}: assistant 段数 ≥3（实际 ${segments.length}）`);
  ok(segments[0]?.startsWith("用户问"), `${label}: 第一段是「用户问…」（实际 ${segments[0]?.slice(0, 12)}）`);
  ok(
    !segments.slice(1).some((text) => text.startsWith("用户问")),
    `${label}: 第一段没有重复出现（${joined.slice(0, 40)}）`,
  );
  const steerAt = segments.findIndex((text) => text.includes("用户 steer"));
  ok(steerAt > 0, `${label}: steer 的思考在第一段之后（第 ${steerAt + 1} 段）`);
  const ids = rig.toolIds();
  ok(new Set(ids).size === ids.length, `${label}: 工具行无重复（共 ${ids.length} 条）`);

  // 分块边界才是用户看到的东西：partitionTurnItems 让 steer notice 切断折叠段，
  // 所以「steer 之后的思考落到了 steer 之前」和「顺序对但分段错」是两回事。
  const items = rig.controller().state.items;
  const steerIndexes = items
    .map((item, index) => (item.kind === "notice" && String((item as { text?: string }).text ?? "").includes(STEER_MARK) ? index : -1))
    .filter((index) => index >= 0);
  ok(steerIndexes.length === 1, `${label}: steer notice 只有 1 条（实际 ${steerIndexes.length}）`);
  const steerIndex = steerIndexes[0] ?? -1;
  const assistantsBefore = items.slice(0, steerIndex).filter((item) => item.kind === "assistant").length;
  const assistantsAfter = items.slice(steerIndex + 1).filter((item) => item.kind === "assistant").length;
  ok(assistantsBefore === 1, `${label}: steer 之前只有 1 段思考（实际 ${assistantsBefore}）`);
  ok(assistantsAfter >= 2, `${label}: steer 之后 ≥2 段思考（实际 ${assistantsAfter}）`);

  // 折叠分组：steer 之后应当只有一个 process 段承载多段思考。
  const parts = partitionTurnItems(items);
  const steerPartIndex = parts.findIndex((part) =>
    part.outsideItems.some((item) => String((item as { text?: string }).text ?? "").includes(STEER_MARK)));
  const laterAssistants = parts.slice(steerPartIndex + 1)
    .flatMap((part) => part.processItems.filter((item) => item.kind === "assistant"));
  ok(
    laterAssistants.length >= 2,
    `${label}: steer 之后的分块里 ≥2 段思考（实际 ${laterAssistants.length}，共 ${parts.length} 块）`,
  );
}

async function scenario(name: string, run: (rig: Rig) => Promise<void>, options: { deferPage?: boolean } = {}) {
  process.stdout.write(`\n${name}\n`);
  const rig = await createRig(options);
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

// ── 场景 1：流式途中切走，再切回 ────────────────────────────────────────────
await scenario("流式进行中切走 → 切回", async (rig) => {
  const tab = rig.tabA.id;
  await rig.fire({ kind: "turn_started", tabId: tab, turnId: "t1", seq: 51 } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa1", "m1", 52));
  await rig.fire(reasoning(tab, "t1", 53, "用户问：每个包有文档或者介绍吗？"));
  for (const event of toolCall(tab, "t1", 54, "callA1")) await rig.fire(event);
  await rig.fire({ kind: "steer", tabId: tab, turnId: "t1", text: STEER, itemId: "ib1" } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa2", "m2", 56));
  // 第二段思考流到一半就切走
  await rig.fire(reasoning(tab, "t1", 57, "用户 steer：看完包介绍后，"));
  await rig.switchTo(rig.tabB.id);
  await rig.fire(reasoning(tab, "t1", 58, "围绕主干"));
  rig.pageState.messages = historyRows();
  await rig.switchTo(rig.tabA.id);
  await waitFor("hydrate after switch back", () => rig.reasoningOf().some((text) => text.includes("继续拿剩余")));
  assertStreamedOrder(rig, "切走切回");
});

// ── 场景 2：页面在流式途中到达（替换） ──────────────────────────────────────
await scenario("流式中页面到达", async (rig) => {
  const tab = rig.tabA.id;
  await rig.fire({ kind: "turn_started", tabId: tab, turnId: "t1", seq: 51 } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa1", "m1", 52));
  await rig.fire(reasoning(tab, "t1", 53, "用户问：每个包有文档或者介绍吗？"));
  for (const event of toolCall(tab, "t1", 54, "callA1")) await rig.fire(event);
  await rig.fire({ kind: "steer", tabId: tab, turnId: "t1", text: STEER, itemId: "ib1" } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa2", "m2", 56));
  await rig.fire(reasoning(tab, "t1", 57, "用户 steer：看完包介绍后，围绕主干"));
  // 页面在这个时刻到达，且磁盘已落后于 live
  rig.pageState.messages = historyRows();
  rig.gated?.resolve(historyRows());
  await rig.settle();
  assertStreamedOrder(rig, "页面中途到达");
}, { deferPage: true });

// ── 场景 3：工具轮之间插入消息，流未结束就切换 ──────────────────────────────
await scenario("工具轮间插入消息 + 未结束切换", async (rig) => {
  const tab = rig.tabA.id;
  await rig.fire({ kind: "turn_started", tabId: tab, turnId: "t1", seq: 51 } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa1", "m1", 52));
  await rig.fire(reasoning(tab, "t1", 53, "用户问：每个包有文档或者介绍吗？"));
  for (const event of toolCall(tab, "t1", 54, "callA1")) await rig.fire(event);
  for (const event of toolCall(tab, "t1", 56, "callA2")) await rig.fire(event);
  await rig.fire({ kind: "steer", tabId: tab, turnId: "t1", text: STEER, itemId: "ib1" } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa2", "m2", 58));
  await rig.fire(reasoning(tab, "t1", 59, "用户 steer：看完包介绍后"));
  rig.pageState.messages = historyRows();
  await rig.switchTo(rig.tabB.id);
  await rig.switchTo(rig.tabA.id);
  await rig.settle();
  assertStreamedOrder(rig, "工具叠加后切换");
});

// ── 场景 4：ask 等待中切换 ─────────────────────────────────────────────────
await scenario("ask 等待中切换", async (rig) => {
  const tab = rig.tabA.id;
  await rig.fire({ kind: "turn_started", tabId: tab, turnId: "t1", seq: 51 } as WireEvent);
  await rig.fire(begin(tab, "t1", "sa1", "m1", 52));
  await rig.fire(reasoning(tab, "t1", 53, "用户问：每个包有文档或者介绍吗？"));
  for (const event of toolCall(tab, "t1", 54, "callA1")) await rig.fire(event);
  await rig.fire({
    kind: "ask_request", tabId: tab, turnId: "t1", seq: 56,
    ask: { id: "ask-1", turnId: "t1", questions: [{ header: "Q", question: "选哪个？", options: [{ label: "A" }] }] },
  } as unknown as WireEvent);
  await rig.switchTo(rig.tabB.id);
  rig.pageState.messages = historyRows();
  await rig.switchTo(rig.tabA.id);
  await rig.settle();
  ok(rig.reasoningOf()[0]?.startsWith("用户问"), "ask 切换后第一段仍是「用户问…」");
});

process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;