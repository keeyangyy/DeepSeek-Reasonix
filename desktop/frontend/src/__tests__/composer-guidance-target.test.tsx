// 插话去处开关：默认本轮、切到队列后走 followup、且按会话隔离。
//
// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/composer-guidance-target.test.tsx

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { enqueueInboxGuidanceForActiveTurn } from "../lib/inboxSubmit";
import { useGuidanceTarget } from "../lib/composerGuidanceTarget";
import type { GuidanceTarget } from "../lib/composerGuidanceTarget";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
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
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}

type Calls = { followup: number; steer: number; steerForTurn: number; withInvocations: number };

function makeBinding(calls: Calls) {
  return {
    ListTabs: async () => [{ id: "tab-a", turnId: "turn-1" }],
    EnqueueInboxFollowup: async () => { calls.followup += 1; return { itemId: "f1" }; },
    EnqueueInboxSteer: async () => { calls.steer += 1; return { itemId: "s1" }; },
    EnqueueInboxSteerForTurn: async () => { calls.steerForTurn += 1; return { itemId: "s2" }; },
    EnqueueInboxFollowupWithInvocations: async () => { calls.withInvocations += 1; return { itemId: "fi1" }; },
  } as never;
}

process.stdout.write("\n插话去处：提交路由\n");

{
  // 默认（preferQueue 省略）→ 走本轮 steer
  const calls: Calls = { followup: 0, steer: 0, steerForTurn: 0 };
  await enqueueInboxGuidanceForActiveTurn(makeBinding(calls), "tab-a", "本轮的话", "本轮的话", undefined, "turn-1");
  process.stdout.write(`  默认调用 = ${JSON.stringify(calls)}\n`);
  ok(calls.steerForTurn === 1 && calls.followup === 0, "默认把插话送进本轮（steer）");
}

{
  // 切到队列 → 走 followup，且不去解析 turn
  const calls: Calls = { followup: 0, steer: 0, steerForTurn: 0 };
  await enqueueInboxGuidanceForActiveTurn(makeBinding(calls), "tab-a", "排队的话", "排队的话", undefined, "turn-1", true);
  process.stdout.write(`  队列调用 = ${JSON.stringify(calls)}\n`);
  ok(calls.followup === 1 && calls.steerForTurn === 0 && calls.steer === 0, "切到队列后只走 followup");
}

{
  // 带技能/命令实体的消息无视开关，始终排队：实体需要自己的回合，
  // 而 steer 通道只承载文本，强行注入会丢掉实体。
  const calls: Calls = { followup: 0, steer: 0, steerForTurn: 0, withInvocations: 0 };
  await enqueueInboxGuidanceForActiveTurn(
    makeBinding(calls),
    "tab-a",
    "/skill 做点事",
    "/skill 做点事",
    { display: "/skill 做点事", input: "/skill 做点事", invocations: [{ name: "skill", kind: "skill", offset: 0 }] } as never,
    "turn-1",
    false,
  );
  process.stdout.write(`  带实体且选本轮 = ${JSON.stringify(calls)}\n`);
  ok(
    calls.withInvocations === 1 && calls.steerForTurn === 0 && calls.followup === 0,
    "带技能/命令的消息无视开关，只进后续队列",
  );
}

process.stdout.write("\n插话去处：会话隔离\n");

{
  const dom = installDom();
  const seen: Record<string, GuidanceTarget> = {};
  const setters: Record<string, (t: GuidanceTarget) => void> = {};
  let currentKey = "session-a";

  function Probe({ draftKey }: { draftKey: string }) {
    const [target, setTarget] = useGuidanceTarget(draftKey);
    seen[draftKey] = target;
    setters[draftKey] = setTarget;
    return <span>{target}</span>;
  }

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  const render = async (key: string) => {
    currentKey = key;
    await act(async () => {
      root.render(<Probe draftKey={currentKey} />);
    });
  };

  await render("session-a");
  ok(seen["session-a"] === "steer", "新会话默认本轮");

  await act(async () => { setters["session-a"]("followup"); });
  ok(seen["session-a"] === "followup", "切到队列后当前会话记住选择");

  await render("session-b");
  ok(seen["session-b"] === "steer", "换会话回到默认本轮（不串会话）");

  await render("session-a");
  ok(seen["session-a"] === "followup", "切回原会话恢复它自己的选择");

  await act(async () => { root.unmount(); });
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
