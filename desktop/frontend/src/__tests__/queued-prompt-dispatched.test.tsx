// 队列 followup 派发后必须出现 user 气泡。
//
// 背景：前端只在用户自己提交时插入 user 项（dispatch({type:"user"})）。
// 队列条目由后端派发成新 turn，靠 queued_prompt_dispatched 事件补上气泡。
//
// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/queued-prompt-dispatched.test.tsx

import { reducer } from "../lib/useController";
import type { State, Action } from "../lib/useController";
import type { WireEvent } from "../lib/types";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}

function baseState(): State {
  return {
    items: [{ kind: "user", id: "u0", text: "先前的消息", submitText: undefined, createdAt: 1 }],
    seq: 1,
    running: true,
    turnActive: true,
    assistantSegmentOrdinal: 0,
    activeTurnId: "turn-1",
    currentAssistant: undefined,
    historyMutation: { seq: 0, kind: "append" },
  } as unknown as State;
}

function applyEvent(s: State, e: WireEvent): State {
  return reducer(s, { type: "event", e } as Action);
}

function userTexts(s: State): string[] {
  return s.items.filter((it) => it.kind === "user").map((it) => (it as { text: string }).text);
}

process.stdout.write("\n队列 followup 派发的 user 气泡\n");

// 1) 收到派发确认 → 插入 user 气泡
{
  const after = applyEvent(baseState(), {
    kind: "queued_prompt_dispatched",
    text: "好的，没问题",
    itemId: "inbox-1",
  } as WireEvent);
  process.stdout.write(`  user 项 = ${JSON.stringify(userTexts(after))}\n`);
  ok(userTexts(after).includes("好的，没问题"), "派发确认插入对应的 user 气泡");
}

// 2) 同一 inbox 条目重复投递 → 不重复插入
{
  let s = applyEvent(baseState(), { kind: "queued_prompt_dispatched", text: "好的", itemId: "inbox-2" } as WireEvent);
  s = applyEvent(s, { kind: "queued_prompt_dispatched", text: "好的", itemId: "inbox-2" } as WireEvent);
  const dup = userTexts(s).filter((t) => t === "好的");
  process.stdout.write(`  重复投递后 user 项 = ${JSON.stringify(userTexts(s))}\n`);
  ok(dup.length === 1, "同一条目重复事件只留一个气泡");
}

// 3) 不同条目、相同文本 → 各自一个气泡（不能按文本去重）
{
  let s = applyEvent(baseState(), { kind: "queued_prompt_dispatched", text: "好的", itemId: "inbox-3" } as WireEvent);
  s = applyEvent(s, { kind: "queued_prompt_dispatched", text: "好的", itemId: "inbox-4" } as WireEvent);
  const same = userTexts(s).filter((t) => t === "好的");
  process.stdout.write(`  两条同文不同条目后 user 项 = ${JSON.stringify(userTexts(s))}\n`);
  ok(same.length === 2, "相同文本但不同条目各留一个气泡");
}

// 4) 空文本不插入
{
  const before = baseState();
  const after = applyEvent(before, { kind: "queued_prompt_dispatched", text: "  ", itemId: "inbox-5" } as WireEvent);
  ok(userTexts(after).length === userTexts(before).length, "空文本不产生气泡");
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
