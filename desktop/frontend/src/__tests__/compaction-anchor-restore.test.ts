// compaction-anchor-restore.test.ts — 切回（hydrate）后压缩卡片按锚点恢复原位：
// 压缩卡片是 live 事件产物（不持久化），切走再切回时按 usersAfter 锚点插回
// 原位置（倒数第 N 个 user 行之前），锚点失效回退 append 末尾（旧行为）。
// 注意：liveCompactionsCache 是模块级单例，各场景必须使用独立 sessionPath。
// 运行：pnpm exec tsx src/__tests__/compaction-anchor-restore.test.ts
import { initialState, reducer } from "../lib/useController";
import type { HistoryMessage } from "../lib/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function userMsg(text: string): HistoryMessage {
  return { role: "user", content: text } as HistoryMessage;
}
function assistantMsg(text: string): HistoryMessage {
  return { role: "assistant", content: text } as HistoryMessage;
}

function compactionCards(items: ReturnType<typeof reducer>["items"]) {
  return items.filter((it) => it.kind === "compaction");
}

console.log("\ncompaction anchor restore");

// 场景 1（核心 bug）：live 压缩 → 又一回合 → 切走切回（controller 重建，
// reset+history）→ 卡片插在压缩发生的位置，而不是消息流最底部。
{
  const SESSION = "t1.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "pressure" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "pressure", messages: 1298, summary: "压一" },
    },
  } as never);
  // 压缩后用户又发了一回合（user append 刷新锚点 → usersAfter=1）
  s = reducer(s, { type: "user", text: "三" } as never);
  // 切走再切回：全新 controller 状态，历史含压缩后完成的回合
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(cards.length === 1, "切回后恰好一张压缩卡片（不重复）");
  const idx = back.items.findIndex((it) => it.kind === "compaction");
  const u3Idx = back.items.findIndex(
    (it) => it.kind === "user" && it.text === "三",
  );
  const a2Idx = back.items.reduce(
    (acc, it, i) => (it.kind === "assistant" && it.text === "答二" ? i : acc),
    -1,
  );
  ok(
    idx === a2Idx + 1 && u3Idx === idx + 1,
    "卡片插在压缩发生的位置（答二之后、新回合之前），不是最底部",
  );
  ok((cards[0] as { summary?: string }).summary === "压一", "摘要内容正确");
}

// 场景 2：压缩后无新回合（usersAfter=0）→ 切回后仍在末尾（与旧行为一致）。
{
  const SESSION = "t2.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 3, summary: "压零" },
    },
  } as never);
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(
    cards.length === 1 &&
      back.items[back.items.length - 1].kind === "compaction",
    "无新回合时卡片仍在末尾",
  );
}

// 场景 3：锚点越界（rewind 后 user 行变少）→ 回退 append 末尾，不丢失。
{
  const SESSION = "t3.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压二" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "三" } as never);
  // rewind 后历史只剩第一回合：锚点（倒数第 1 个 user 之前）越界
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(
    cards.length === 1 &&
      back.items[back.items.length - 1].kind === "compaction",
    "锚点越界回退到末尾且不丢失",
  );
}

// 场景 4：历史产物已含压缩卡片（老格式 role:"compaction"）→ 不叠加（防重复）。
{
  const SESSION = "t4.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压三" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "二" } as never);
  const back = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      {
        role: "compaction",
        trigger: "manual",
        messages: 4,
        summary: "压三",
      } as unknown as HistoryMessage,
      userMsg("二"),
    ],
    seq: 3,
    remote: false,
  } as never);
  ok(compactionCards(back.items).length === 1, "历史已含卡片时不叠加");
}

// 场景 5：同 controller 内 reset（prevItems 携带卡片，实时算锚点）→ history 后归位。
{
  const SESSION = "t5.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压四" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "三" } as never);
  // 同 controller 内触发 hydrate（如 resume）：reset 保留卡片，history 重建
  s = reducer(s, { type: "reset" } as never);
  s = reducer(s, { type: "meta", meta: { sessionPath: SESSION } } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  const idx = s.items.findIndex((it) => it.kind === "compaction");
  const u3Idx = s.items.findIndex(
    (it) => it.kind === "user" && it.text === "三",
  );
  ok(
    compactionCards(s.items).length === 1 && idx === u3Idx - 1,
    "同 controller hydrate 后卡片同样归位",
  );
}

// 场景 6：多张卡片 → 各自按锚点归位，互不干扰、不重复。
{
  const SESSION = "t6.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  // 第一张卡片落在"二"回合后，再走一回合，第二张卡片落在"三"回合后
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "pressure" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "pressure", messages: 10, summary: "压A" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "四" } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 6, summary: "压B" },
    },
  } as never);
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
      userMsg("四"),
      assistantMsg("答四"),
    ],
    seq: 8,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(cards.length === 2, "两张卡片都恢复（不重复）");
  const idxA = back.items.findIndex(
    (it) =>
      it.kind === "compaction" &&
      (it as { summary?: string }).summary === "压A",
  );
  const idxB = back.items.findIndex(
    (it) =>
      it.kind === "compaction" &&
      (it as { summary?: string }).summary === "压B",
  );
  const u4Idx = back.items.findIndex(
    (it) => it.kind === "user" && it.text === "四",
  );
  ok(
    idxA === u4Idx - 1 && idxB === back.items.length - 1,
    "压A 在四回合前、压B 在末尾（各自锚点）",
  );
}

console.log(`\ncompaction anchor restore: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
