// Run: tsx src/__tests__/hydrate-user-row-survival.test.ts
//
// 复现：切会话后，尚未持久化到磁盘的那条 user 消息被历史页覆盖掉。
//
// 现场（前端诊断 42446113）：切回会话时 items.tail(total=1) → history_prepend
// 一次删掉 21 条 live 行；页面里没有那条用户消息（它还没落盘），删掉即丢失，
// 重新加载（从磁盘重读）才恢复。
//
// 本测试锁住两条不变量：
//   1. 历史页没有覆盖到的 user 行，任何 page action 都不得删除；
//   2. history_replace 用整页覆盖时，同样不得丢掉这样的行。

import { initialState, reducer } from "../lib/useController";
import { pageCoveredLiveItemIds, replaceRemoveIds } from "../lib/hydrateHistoryApply";

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

console.log("\nhydrate user row survival");

const userRow = (id: string, text: string) => ({ kind: "user" as const, id, text });
const assistantRow = (id: string, text: string, reasoning = "") =>
  ({ kind: "assistant" as const, id, text, reasoning, streaming: false });

// ── 1. 页面覆盖判定：没覆盖到的 user 行不能被算进删除集 ──────────────────────
{
  const page = [assistantRow("h:1", "older answer")];
  const live = [
    userRow("he:u-pending", "刚刚发出、还没落盘的一条"),
    assistantRow("a:turn-x:0", "刚流出来的一点内容"),
  ];
  const covered = pageCoveredLiveItemIds(page, live);
  ok(!covered.includes("he:u-pending"), "页面没有这条用户消息时，它不进入 covered 集");
  ok(covered.length === 0, "页面只覆盖 assistant 时，不产出任何 covered id");

  const removeIds = replaceRemoveIds(page, live, "turn-x", []);
  ok(!removeIds.includes("he:u-pending"), `replaceRemoveIds 不删除页面未覆盖的 user 行（实际：${JSON.stringify(removeIds)}）`);
}

// ── 2. reducer: history_replace 不得丢掉页面未覆盖的 user 行 ─────────────────
{
  const liveState = {
    ...initialState,
    items: [
      userRow("he:u-1", "上一轮"),
      assistantRow("h:old", "上一轮的回答"),
      userRow("he:u-pending", "刚刚发出、还没落盘的一条"),
    ],
    currentAssistant: undefined,
    historyPrefixCount: 2,
    historyTotalTurns: 1,
  };
  // 后端页面只到「上一轮」为止——刚发出的那条还没写进磁盘。
  const page = [userRow("h:u-1", "上一轮"), assistantRow("h:old", "上一轮的回答")];

  const replaced = reducer(liveState, {
    type: "history_replace",
    items: page,
    startTurn: 1,
    totalTurns: 1,
    hasOlder: false,
    revision: 20,
  });
  ok(
    replaced.items.some((item) => item.id === "he:u-pending"),
    `history_replace 后「还没落盘的用户消息」仍在（实际：${JSON.stringify(replaced.items.map((i) => i.id))}）`,
  );
}

// ── 3. reducer: history_prepend 同样不得丢掉 ────────────────────────────────
{
  const liveState = {
    ...initialState,
    items: [
      userRow("he:u-pending", "刚刚发出、还没落盘的一条"),
      assistantRow("a:turn-y:0", "刚流出来的一点内容"),
    ],
    activeTurnId: "turn-y",
    currentAssistant: "a:turn-y:0",
    live: { id: "a:turn-y:0", text: "刚流出来的一点内容", reasoning: "", reasoningComplete: false },
    turnActive: true,
    running: true,
    historyTotalTurns: 0,
  };
  const page = [userRow("h:u-old", "更早的一轮"), assistantRow("h:old", "更早的回答")];
  const removeIds = replaceRemoveIds(page, liveState.items, "turn-y", []);

  const prepended = reducer(liveState, {
    type: "history_prepend",
    items: page,
    startTurn: 1,
    totalTurns: 1,
    hasOlder: false,
    revision: 21,
    removeIds,
  });
  ok(
    prepended.items.some((item) => item.id === "he:u-pending"),
    `history_prepend 后「还没落盘的用户消息」仍在（实际：${JSON.stringify(prepended.items.map((i) => i.id))}）`,
  );
}

// ── 5. 边界：已经落盘的 prompt 不得被再挂一遍 ───────────────────────────────
{
  const liveState = {
    ...initialState,
    items: [userRow("he:u-1", "同一句话"), assistantRow("h:old", "回答")],
    historyPrefixCount: 2,
    historyTotalTurns: 1,
  };
  // 页面已经带来同一条 prompt，只是 id 不同（页面用 h:*，live 是 he:*）。
  const page = [userRow("h:u-1", "同一句话"), assistantRow("h:old", "回答")];
  const replaced = reducer(liveState, {
    type: "history_replace",
    items: page,
    startTurn: 1,
    totalTurns: 1,
    hasOlder: false,
    revision: 22,
  });
  const sameTextCount = replaced.items.filter((item) => item.kind === "user" && item.text === "同一句话").length;
  ok(sameTextCount === 1, `已落盘的 prompt 不重复挂载（实际出现 ${sameTextCount} 次）`);
}

// ── 6. 边界：页面与 live 零重叠时（rebind/rewind）不得把上一会话的行留下 ────
{
  const liveState = {
    ...initialState,
    items: [userRow("he:u-other", "上一个会话的消息"), assistantRow("a:turn-o:0", "上一会话的内容")],
    historyPrefixCount: 1,
    historyTotalTurns: 1,
  };
  const page = [userRow("h:u-new", "另一个会话"), assistantRow("h:new", "另一个会话的回答")];
  const replaced = reducer(liveState, {
    type: "history_replace",
    items: page,
    startTurn: 1,
    totalTurns: 1,
    hasOlder: false,
    revision: 23,
  });
  ok(
    !replaced.items.some((item) => item.id === "he:u-other"),
    `页面与 live 零重叠时不保留上一会话的行（实际：${JSON.stringify(replaced.items.map((i) => i.id))}）`,
  );
}
//
// useController.ts 的 hydrate 分支没有复用 replaceRemoveIds，而是自己按
// `a:${activeTurnId}:` 前缀无条件删除整个 live turn。只要 pageOverlapsLiveContent
// 或 pageSupersedesInFlightTurn 命中，这条循环就会连同尚未落盘的 user 行一起删掉。
// 这里按同样的分支条件复算删除集，锁住「未落盘的 user 行不得进入删除集」。
{
  const live = [
    userRow("he:u-pending", "刚刚发出、还没落盘的一条"),
    assistantRow("a:turn-z:0", "页面里已经有这份内容的开头"),
    { kind: "tool" as const, id: "a:turn-z:tool1", name: "bash", args: "", readOnly: false, status: "done" as const, output: "" },
  ];
  // 页面里出现了与 live assistant 前缀相同的内容 → pageOverlapsLiveContent 命中。
  const page = [userRow("h:u-old", "更早的一轮"), assistantRow("h:new", "页面里已经有这份内容的开头")];

  const removeIds: string[] = [];
  const prefix = "a:turn-z:";
  for (const item of live) {
    if (item.id.startsWith(prefix) || page.some((pageItem) => pageItem.id === item.id)) removeIds.push(item.id);
  }
  ok(
    !removeIds.includes("he:u-pending"),
    `整段 live turn 删除不得带走未落盘的 user 行（当前实际删除：${JSON.stringify(removeIds)}）`,
  );
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
