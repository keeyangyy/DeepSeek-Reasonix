// Run: tsx src/__tests__/blank-reasoning-rows.test.tsx
//
// 复现：reasoning 是**纯空白**（真实数据是单个空格 " "）时，折叠头把它算作
// 「1 段思考」，展开后却没有任何正文。
//
// 现场数据（会话 20261018-162854…-axon-deepseek-flash，820 条 assistant 行）：
//   reasoning_content == ""     → 213 条
//   reasoning_content == " "    → 559 条   ← 问题来源
//   真正有内容                   →  48 条
// 这 1592 条纯空白的 assistant（events 口径）全部另有工具调用或正文，没有一条是空的。
//
// 根因是两处判据不一致：
//   foldDisplayItems 用 Boolean(it.reasoning)   → " " 为 truthy，计入段数
//   正文渲染用   shown.reasoning.trim()          → " " 变 ""，返回 null 不渲染
//
// 本测试锁住统一后的契约：纯空白 reasoning 不构成可展开的思考段。

import { act } from "react";
import { createTranscriptHarness } from "./transcript-dom-harness";
import type { Item } from "../lib/useController";

let passed = 0;
let failed = 0;

function ok(value: unknown, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

console.log("\nblank reasoning rows");

const harness = await createTranscriptHarness();
const { container } = harness;

function foldLabels(): string[] {
  return Array.from(container.querySelectorAll(".turn-collapse__label"))
    .map((element) => element.textContent ?? "");
}

function reasoningPhases(): number {
  return container.querySelectorAll(".turn-collapse__reasoning-phase").length;
}

/** 展开所有折叠头，等多帧让懒挂载完成。 */
async function expandAll() {
  const heads = Array.from(container.querySelectorAll<HTMLButtonElement>(".reasoning__head"));
  for (const head of heads) {
    if (head.getAttribute("aria-expanded") === "true") continue;
    await act(async () => {
      head.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  await harness.settle();
}

try {
  // 真实形态：assistant 有正文和工具调用，reasoning 只是一个空格。
  const items: Item[] = [
    { kind: "user", id: "u1", text: "先检查当前实际状态" },
    { kind: "assistant", id: "a1", text: "我先检查当前实际状态，确认还有哪些未收尾项。", reasoning: " ", streaming: false },
    { kind: "tool", id: "t1", name: "bash", args: "{}", readOnly: false, status: "done", output: "" },
    { kind: "tool", id: "t2", name: "bash", args: "{}", readOnly: false, status: "done", output: "" },
  ];

  await harness.render(items, { running: false });

  const labels = foldLabels();
  ok(
    !labels.some((text) => /\d+\s*(段思考|thoughts)/.test(text)),
    `纯空白 reasoning 不计入思考段数（折叠头实际：${JSON.stringify(labels)}）`,
  );
  ok(reasoningPhases() === 0, `不渲染任何思考块（实际渲染 ${reasoningPhases()} 个）`);

  await expandAll();
  const bodies = Array.from(container.querySelectorAll(".turn-collapse__inline-reasoning"))
    .map((element) => element.textContent ?? "");
  ok(bodies.length === 0, `展开后也不出现空白思考正文（实际：${JSON.stringify(bodies)}）`);

  // 对照：真正有内容的 reasoning 仍然正常显示为一段思考。
  const withReal: Item[] = [
    { kind: "user", id: "u2", text: "再看这次" },
    { kind: "assistant", id: "a2", text: "好的", reasoning: "REAL_THOUGHT", streaming: false },
  ];
  await harness.render(withReal, { running: false });
  const labels2 = foldLabels();
  ok(
    labels2.some((text) => /\d+\s*(段思考|thoughts)/.test(text)),
    `有真实内容时仍报思考段数（折叠头实际：${JSON.stringify(labels2)}）`,
  );
  await expandAll();
  const bodies2 = Array.from(container.querySelectorAll(".turn-collapse__inline-reasoning"))
    .map((element) => element.textContent ?? "");
  ok(bodies2.some((text) => text.includes("REAL_THOUGHT")), `有真实内容时展开可见（实际：${JSON.stringify(bodies2)}）`);
} finally {
  await harness.unmount();
  await harness.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
