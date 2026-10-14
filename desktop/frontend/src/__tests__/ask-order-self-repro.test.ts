// Run: tsx src/__tests__/ask-order-self-repro.test.ts
//
// 自复现 ask 顺序错乱（v1.38.29 基线）：多工具并发（ask + bash）事件流
// 驱动 reducer，断言 transcript items 行序与事件到达顺序一致。
// 用户观察：多个工具一起调用（有 ask 有 bash）时容易乱序，
// "ask 的结果放最下面，直到 assistant 结果回复出现才恢复"。

import { initialState, reducer } from "../lib/useController";

let passed = 0;
let failed = 0;

function ok(cond: unknown, label: string) {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}（缺陷复现）\n`);
    failed += 1;
  }
}

function startTurn() {
  return reducer(initialState, { type: "user", text: "q1", seq: 0, submissionId: "s0" } as never);
}

function kinds(s: ReturnType<typeof reducer>): string[] {
  return s.items.map((it) => (it.kind === "tool" ? `tool:${it.name}:${it.status}` : it.kind));
}

console.log("\nask order self-repro (多工具并发)");

// 场景1：assistant 段 → ask dispatch → bash dispatch → ask_request → bash result → assistant 继续
{
  let s = startTurn();
  s = reducer(s, { type: "event", e: { kind: "text", turnId: "t1", text: "I'll check" } } as never);
  s = reducer(s, { type: "event", e: { kind: "tool_dispatch", tool: { id: "ask-1", name: "ask", args: "", status: "running" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "tool_dispatch", tool: { id: "bash-1", name: "Bash", args: "", status: "running" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "ask_request", turnId: "t1", ask: { id: "ask-1", questions: [{ id: "q1", prompt: "Go?" }] } } } as never);
  s = reducer(s, { type: "event", e: { kind: "tool_result", tool: { id: "bash-1", name: "Bash", status: "done", content: "ok" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "text", turnId: "t1", text: "Done." } } as never);
  const seq = kinds(s);
  const askIdx = seq.indexOf("tool:ask:running");
  const bashIdx = seq.indexOf("tool:Bash:done");
  const doneTextIdx = seq.lastIndexOf("assistant");
  ok(askIdx >= 0 && bashIdx >= 0, "ask 行与 bash 行均存在");
  ok(askIdx < bashIdx, "事件顺序保持：ask 行在 bash 行之前（实际 " + askIdx + "/" + bashIdx + "）");
  ok(doneTextIdx > bashIdx, "assistant 后续输出在工具行之后（实际 doneText=" + doneTextIdx + " bash=" + bashIdx + "）");
}

// 场景2：ask 回答后 ask 工具 result 回填原位（不 append 到末尾）
{
  let s = startTurn();
  s = reducer(s, { type: "event", e: { kind: "tool_dispatch", tool: { id: "ask-1", name: "ask", args: "", status: "running" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "ask_request", turnId: "t1", ask: { id: "ask-1", questions: [{ id: "q1", prompt: "Go?" }] } } } as never);
  s = reducer(s, { type: "event", e: { kind: "tool_result", tool: { id: "ask-1", name: "ask", status: "done", content: "answer: yes" } } } as never);
  const seq = kinds(s);
  const askIdx = seq.indexOf("tool:ask:done");
  const lastIdx = seq.length - 1;
  ok(askIdx >= 0, "ask 工具 result 后存在 ask 行");
  ok(askIdx === lastIdx, "[缺陷] ask result 回填原位（工具行末尾即原位，实际 " + askIdx + "/" + lastIdx + "）——若后续消息 append 到其后属正常流");
}

// 场景3：ask 暂停期间其他工具 result 先到（并行）——bash result 填充原位不产生新行
{
  let s = startTurn();
  s = reducer(s, { type: "event", e: { kind: "tool_dispatch", tool: { id: "ask-1", name: "ask", args: "", status: "running" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "tool_dispatch", tool: { id: "bash-1", name: "Bash", args: "", status: "running" } } } as never);
  s = reducer(s, { type: "event", e: { kind: "ask_request", turnId: "t1", ask: { id: "ask-1", questions: [{ id: "q1", prompt: "Go?" }] } } } as never);
  const before = kinds(s).length;
  s = reducer(s, { type: "event", e: { kind: "tool_result", tool: { id: "bash-1", name: "Bash", status: "done", content: "ok" } } } as never);
  const after = kinds(s);
  const bashDone = after.filter((k) => k === "tool:Bash:done").length;
  ok(after.length === before, "bash result 填充原位不新增行（before=" + before + " after=" + after.length + "）");
  ok(bashDone === 1, "bash 行只有一行（原位填充，" + bashDone + "）");
}

console.log(`\nask self-repro: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
