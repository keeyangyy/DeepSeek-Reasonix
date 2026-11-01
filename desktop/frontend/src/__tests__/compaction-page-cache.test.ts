// compaction-page-cache.test.ts — 复杂会话场景下的压缩卡片位置：
//   1) 分页重建（history_page 的 replace / prepend）不能丢掉已插入的卡片
//   2) 缓存归属：同会话命中、归属未知不丢、跨会话丢弃
//   3) 多次压缩：后一次替换前一次，不并排
// 运行：node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/compaction-page-cache.test.ts
import { initialState, reducer, type Item } from "../lib/useController";
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

function u(text: string): HistoryMessage {
  return { role: "user", content: text } as HistoryMessage;
}
function a(text: string): HistoryMessage {
  return { role: "assistant", content: text } as HistoryMessage;
}
function cards(items: Item[]) {
  return items.filter((it) => it.kind === "compaction") as Array<Extract<Item, { kind: "compaction" }>>;
}
function userCountBefore(items: Item[], index: number) {
  return items.slice(0, index).filter((it) => it.kind === "user").length;
}

function baseState(sessionPath: string, messages: HistoryMessage[]) {
  let s = reducer(initialState, { type: "meta", meta: { sessionPath } } as never);
  s = reducer(s, { type: "history", messages, seq: messages.length, remote: false } as never);
  return s;
}

function withCard(sessionPath: string, messages: HistoryMessage[], anchorUsers: number) {
  const s = baseState(sessionPath, messages);
  return reducer(s, {
    type: "latest_compaction",
    tabId: "t",
    sessionPath,
    record: { trigger: "manual", messages: 2, summary: "S", anchorUsers },
  } as never);
}

const sixTurns = [u("q1"), a("a1"), u("q2"), a("a2"), u("q3"), a("a3"), u("q4"), a("a4")];

// ── 1. 分页 replace：整页替换后卡片仍在，且仍在同一轮边界 --------------------
{
  const path = "page-replace.jsonl";
  let s = withCard(path, sixTurns, 3);
  const idxBefore = s.items.findIndex((it) => it.kind === "compaction");
  ok(idxBefore >= 0, "分页前卡片存在");
  ok(userCountBefore(s.items, idxBefore) === 3, "分页前卡片位于第 3 轮之后");

  // 服务端返回一整页（不含卡片），replace 重建 items
  s = reducer(s, {
    type: "history_page",
    mode: "replace",
    page: { messages: sixTurns, startTurn: 0, totalTurns: 4, hasOlder: false },
  } as never);

  const idxAfter = s.items.findIndex((it) => it.kind === "compaction");
  ok(cards(s.items).length === 1, "replace 重建后卡片仍只有一张");
  ok(idxAfter >= 0, "replace 重建后卡片没被冲掉");
  ok(idxAfter >= 0 && userCountBefore(s.items, idxAfter) === 3, "replace 重建后卡片仍在第 3 轮之后");
}

// ── 2. 分页 prepend：加载更早的页，卡片仍锚在原来的相对轮次 ------------------
{
  const path = "page-prepend.jsonl";
  let s = withCard(path, sixTurns, 3);
  const older = [u("q-2"), a("a-2"), u("q-1"), a("a-1")];

  s = reducer(s, {
    type: "history_page",
    mode: "prepend",
    page: { messages: older, startTurn: -2, totalTurns: 6, hasOlder: false },
  } as never);

  const idx = s.items.findIndex((it) => it.kind === "compaction");
  ok(cards(s.items).length === 1, "prepend 后卡片仍只有一张");
  ok(idx >= 0, "prepend 后卡片没被冲掉");
  // 前面插入了 2 轮，卡片应相对后移 2 轮，但仍锚在「压缩关闭的那一轮」之后
  ok(idx >= 0 && userCountBefore(s.items, idx) === 5, "prepend 后卡片相对轮次保持（3+2）");
}

// ── 3. 缓存归属：同会话 / 归属未知 / 跨会话 --------------------------------
{
  // 同会话：切走再切回（history 重建）应恢复
  const samePath = "cache-same.jsonl";
  let s = withCard(samePath, sixTurns, 2);
  s = reducer(s, { type: "history", messages: sixTurns, seq: sixTurns.length, remote: false } as never);
  ok(cards(s.items).length === 1, "同会话重建后卡片从缓存恢复");

  // 跨会话：换到别的 sessionPath 且历史里没有卡片 → 不应串过来
  const otherPath = "cache-other.jsonl";
  let o = withCard(otherPath, sixTurns, 2);
  // 先落地新会话的 meta，再重建 items（真实切换顺序）
  o = reducer(o, { type: "meta", meta: { sessionPath: "cache-other-2.jsonl" } } as never);
  o = reducer(o, {
    type: "history_replace",
    items: [u("x1"), a("x2")],
    revision: 1,
    digest: "d",
  } as never);
  ok(cards(o.items).length === 0, "跨会话重建时不串卡片");

  // 归属未知（重启早期 meta 未落地）：不能当成别的会话丢掉
  const unknownPath = "cache-unknown.jsonl";
  let n = withCard(unknownPath, sixTurns, 2);
  n = reducer(n, { type: "history", messages: sixTurns, seq: sixTurns.length, remote: false } as never);
  ok(cards(n.items).length === 1, "归属未知的卡片不被丢弃");
}

// ── 4. 多次压缩：后一次替换前一次，不并排 --------------------------------
{
  const path = "multi-compact.jsonl";
  let s = withCard(path, sixTurns, 2);
  ok(cards(s.items).length === 1, "首次压缩后一张卡");

  s = reducer(s, {
    type: "latest_compaction",
    tabId: "t",
    sessionPath: path,
    record: { trigger: "manual", messages: 4, summary: "S2", anchorUsers: 4 },
  } as never);

  const cs = cards(s.items);
  ok(cs.length === 2, "两次不同压缩各保留一张（live 事件语义）");
  const idx = s.items.findIndex((it) => it.kind === "compaction" && it.summary === "S2");
  ok(idx >= 0 && userCountBefore(s.items, idx) === 4, "第二次压缩的卡片落在第 4 轮之后");
}

// ── 5. 锚点超出窗口：落到末尾而不是塞进无关回合 ---------------------------
{
  const path = "anchor-overflow.jsonl";
  const s = withCard(path, sixTurns, 99);
  const idx = s.items.findIndex((it) => it.kind === "compaction");
  ok(idx === s.items.length - 1, "锚点超出窗口时卡片落到末尾");
}

process.stdout.write(`\ncompaction page/cache: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
