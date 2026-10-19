// Run: tsx src/__tests__/reasoning-live-vs-item.test.tsx
//
// 复现：折叠头显示「1 段思考」，展开后正文为空。
//
// 现场（前端诊断 42446113，切会话后）：item.reasoning 有内容，但同一时刻
// live.reasoning 为空。ProcessFoldHeader 数段数看的是 segment.displayItems
// 里的 item.reasoning；InlineAssistantReasoning 的正文只要
// live.id === item.id 就只读 live.reasoning，于是头显示有、正文渲染 null。
//
// 本测试锁住正确契约：块是否渲染、渲染什么，都必须覆盖 item 与 live 两个
// 来源里非空的那个。

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

console.log("\nreasoning live vs item");

const harness = await createTranscriptHarness();
const { container } = harness;

/** 折叠头的文案（含「N 段思考」这类计数）。 */
function foldHeaders(): string[] {
  return Array.from(container.querySelectorAll(".turn-collapse__label"))
    .map((element) => element.textContent ?? "");
}

/** 展开状态下思路正文的文本。 */
function openReasoningBodies(): string[] {
  return Array.from(container.querySelectorAll(".turn-collapse__reasoning-phase--open"))
    .map((element) => element.querySelector(".turn-collapse__inline-reasoning")?.textContent ?? "");
}

/** 点开第一段思路，并把折叠体的懒挂载/懒 Markdown 全部等出来。 */
async function expandFirstFold() {
  const head = container.querySelector<HTMLButtonElement>(".reasoning__head");
  if (!head) return false;
  if (head.getAttribute("aria-expanded") === "true") return true;
  await act(async () => {
    head.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await harness.settle();
  return true;
}

try {
  // 历史行带着 reasoning，live 还没来得及填（或已被清空）的那一刻。
  const items: Item[] = [
    { kind: "user", id: "u1", text: "看看这个错误是怎么修复的" },
    { kind: "assistant", id: "a1", text: "先确认三道防护", reasoning: "PROCESS_TEXT_1", streaming: false },
  ];

  await harness.render(items, {
    running: true,
    live: { id: "a1", text: "先确认三道防护", reasoning: "", reasoningComplete: false },
  });

  const headers = foldHeaders();
  ok(headers.some((text) => text.includes("1")), `折叠头报告了思考段数（实际：${JSON.stringify(headers)}）`);

  // 展开它。
  const expanded = await expandFirstFold();
  ok(expanded, "折叠头可点击展开");

  const bodies = openReasoningBodies();
  const allPhases = Array.from(container.querySelectorAll(".turn-collapse__reasoning-phase"))
    .map((element) => element.textContent ?? "");
  const reasoningsInDom = container.querySelectorAll(".turn-collapse__inline-reasoning").length;
  process.stdout.write(
    `  INFO  phases=${JSON.stringify(allPhases)} inline=${reasoningsInDom} bodies=${JSON.stringify(bodies)}\n`,
  );
  ok(
    bodies.some((text) => text.includes("PROCESS_TEXT_1")),
    `展开后应显示 item 上的 reasoning（实际：${JSON.stringify(bodies)}）`,
  );

  // 对照组：只把 live.reasoning 填上非空值，其余不变。两条断言合起来才能
  // 证明因果在「live 为空时忽略 item.reasoning」，而不是折叠体懒挂载。
  await harness.render(items, {
    running: true,
    live: { id: "a1", text: "先确认三道防护", reasoning: "LIVE_TEXT", reasoningComplete: false },
  });
  await expandFirstFold();
  const controlBodies = openReasoningBodies();
  process.stdout.write(`  INFO  control bodies=${JSON.stringify(controlBodies)}\n`);
  ok(
    controlBodies.some((text) => text.includes("LIVE_TEXT")),
    `对照组：live.reasoning 非空时渲染出 live 的内容（实际：${JSON.stringify(controlBodies)}）`,
  );
} finally {
  await harness.unmount();
  await harness.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
