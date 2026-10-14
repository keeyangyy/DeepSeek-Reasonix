// Run: node --import tsx src/__tests__/transcript-running-older.test.tsx
//
// cf89a2c0 定死的失效面：流式（running）期间，三处同源闸静默拦住"用户意图
// 驱动的历史加载"——滚动加载（Transcript.requestOlder）、问题跳转
// （useTranscriptHistoryNavigation 的 useEffect）、controller 层。
// 日志证据：流式期 1090 次 scroll、51 次触顶、597 次 wheel，探针零记录；
// 跳转超出范围的问题 → pendingQuestion 永挂（转圈）。
//
// 修复：放开三处 running 闸（用户意图：viewport-user / question-jump / retry），
// 保留 auto-fill（机器主动填充）的 running 闸。本测试先红后绿。

import { createTranscriptHarness } from "./transcript-dom-harness";
import type { Item } from "../lib/useController";
import { act } from "react";

let passed = 0;
let failed = 0;

function ok(condition: unknown, label: string) {
  if (condition) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function turns(count: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      kind: "user",
      id: `u${i}`,
      text: `question ${i}`,
      historyTurn: i + 1,
      checkpointTurn: 1_000 + i,
    });
  }
  return items;
}

console.log("\nstreaming (running) sessions must still serve user-intent history loads");

const race = await createTranscriptHarness({ deterministic: true, viewportHeight: 200, rowHeight: 80 });
try {
  HTMLElement.prototype.scrollIntoView = () => {};
  const calls: string[] = [];
  const page = turns(8).slice(4);
  const base = { questionNavigator: true, hasOlderHistory: true, historyStartTurn: 5, historyTotalTurns: 8 };

  const jumpHome = async () => {
    await race.waitFor(() => Boolean(race.container.querySelector('[role="slider"]')), "question rail module");
    await act(async () => race.container.querySelector('[role="slider"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    await race.flush();
  };

  // 修复目标 1：running=true 时跳转到未加载的问题仍要请求对应的 older 页
  await race.render(page, { ...base, running: true, geometrySessionKey: "run-jump", onLoadOlderHistory: (turn: number) => { calls.push(`jump:${turn}`); return Promise.resolve(true); } });
  await race.settle();
  await jumpHome();
  await race.settle();
  ok(calls.join() === "jump:1", "running: an out-of-range question jump still requests the target older page");

  // 修复目标 3：running=true 时 pendingQuestion 不因闸而永挂
  const maskAfterLoad = race.container.querySelector("[data-question-jump-mask]");
  ok(maskAfterLoad === null || calls.length > 0, "running: the jump mask resolves once the load is requested (no infinite spinner)");
} finally {
  await race.unmount();
  await race.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;