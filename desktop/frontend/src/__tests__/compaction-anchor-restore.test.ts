// compaction-anchor-restore.test.ts — 压缩卡片按「压缩点那条消息的 id」恢复位置。
//
// 卡片是 live 事件产物（不持久化），重建 items 后按 anchorMessageId 找回位置：
//   - 锚点消息在 items 里 → 插在它之后；
//   - 不在（还没被分页加载）→ 卡片不显示，等它加载进来自然出现。
// 不再数「第几轮」：轮数要两边各自统计，注入消息类型一变就偏，分页窗口一变就漂。
//
// 运行：node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/compaction-anchor-restore.test.ts
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

let seq = 0;
function u(text: string): HistoryMessage {
  seq += 1;
  return { role: "user", content: text, id: `U${seq}` } as HistoryMessage;
}
function a(text: string): HistoryMessage {
  seq += 1;
  return { role: "assistant", content: text, id: `A${seq}` } as HistoryMessage;
}

function cards(items: Item[]) {
  return items.filter((it) => it.kind === "compaction") as Array<Extract<Item, { kind: "compaction" }>>;
}

function base(sessionPath: string, messages: HistoryMessage[]) {
  let s = reducer(initialState, { type: "meta", meta: { sessionPath } } as never);
  return reducer(s, { type: "history", messages, seq: messages.length, remote: false } as never);
}

function restore(sessionPath: string, messages: HistoryMessage[], anchorMessageId?: string) {
  const s = base(sessionPath, messages);
  return reducer(s, {
    type: "latest_compaction",
    tabId: "t",
    sessionPath,
    record: { trigger: "manual", messages: 3, summary: "S", anchorMessageId },
  } as never);
}

// ── 1. 锚点消息存在：卡片紧跟在它之后 ------------------------------------
{
  const q1 = u("问题一");
  const r1 = a("回答一");
  const q2 = u("问题二");
  const r2 = a("回答二");
  const q3 = u("问题三");
  const s = restore("anchor-hit.jsonl", [q1, r1, q2, r2, q3], r2.id);

  const list = s.items;
  const idx = list.findIndex((it) => it.kind === "compaction");
  ok(idx >= 0, "锚点消息存在时卡片出现");
  const prev = list[idx - 1];
  ok(prev?.kind === "assistant" && (prev as { messageID?: string }).messageID === r2.id, "卡片紧跟在锚点消息之后");
  const next = list[idx + 1];
  ok(!!next && (next as { kind: string }).kind === "user", "卡片之后是下一轮用户消息");
}

// ── 2. 锚点消息缺失：卡片不显示（而不是猜一个位置） ----------------------
{
  const q1 = u("问题一");
  const r1 = a("回答一");
  const s = restore("anchor-miss.jsonl", [q1, r1], "NOT-LOADED");
  ok(cards(s.items).length === 0, "锚点消息未加载时卡片不显示");
}

// ── 3. 没有锚点的旧记录：不显示 ------------------------------------------
{
  const s = restore("anchor-legacy.jsonl", [u("问"), a("答")], undefined);
  ok(cards(s.items).length === 0, "旧记录没有锚点时卡片不显示");
}

// ── 4. 分页补齐后卡片出现，位置固定不变 ----------------------------------
{
  const q1 = u("问题一");
  const r1 = a("回答一");
  const q2 = u("问题二");
  const r2 = a("回答二");
  const q3 = u("问题三");

  // 首次只加载后两轮（q1/r1 还没进来）
  let s = base("anchor-page.jsonl", [q2, r2, q3]);
  s = reducer(s, {
    type: "latest_compaction",
    tabId: "t",
    sessionPath: "anchor-page.jsonl",
    record: { trigger: "manual", messages: 3, summary: "S", anchorMessageId: r1.id },
  } as never);
  ok(cards(s.items).length === 0, "锚点不在首屏时卡片不显示");

  // 用户上滑加载更早的一页
  s = reducer(s, {
    type: "history_page",
    mode: "prepend",
    page: { messages: [a("前缀回答"), q1, r1], startTurn: -1, totalTurns: 3, hasOlder: false },
  } as never);

  const list = s.items;
  const idx = list.findIndex((it) => it.kind === "compaction");
  ok(idx >= 0, "加载更早的页后卡片出现");
  const prev = list[idx - 1];
  ok(prev?.kind === "assistant" && (prev as { messageID?: string }).messageID === r1.id, "卡片位置锚在 r1 之后，与加载多少页无关");
}

// ── 5. 同会话重建后卡片从缓存恢复原位 ------------------------------------
{
  const q1 = u("问题一");
  const r1 = a("回答一");
  const q2 = u("问题二");
  const s0 = restore("anchor-rebuild.jsonl", [q1, r1, q2], r1.id);
  const before = s0.items.findIndex((it) => it.kind === "compaction");
  ok(before >= 0, "重建前卡片存在");

  // 同类会话重新 hydrate（history 全量重建，不带卡片）
  const s1 = reducer(s0, { type: "history", messages: [q1, r1, q2], seq: 3, remote: false } as never);
  const after = s1.items.findIndex((it) => it.kind === "compaction");
  ok(after >= 0, "重建后卡片仍在");
  ok(after === before, "重建后位置不变");
}

// ── 6. 跨会话重建不串卡片 ------------------------------------------------
{
  const q1 = u("问题一");
  const r1 = a("回答一");
  let s = restore("anchor-own.jsonl", [q1, r1], r1.id);
  s = reducer(s, { type: "meta", meta: { sessionPath: "anchor-other.jsonl" } } as never);
  s = reducer(s, { type: "history", messages: [u("别的"), a("会话")], seq: 2, remote: false } as never);
  ok(cards(s.items).length === 0, "换会话重建时不串卡片");
}

// ── 7. 压缩中的卡片没有锚点时落在末尾（它刚发生，位置就是结尾） -----------
{
  const s0 = base("anchor-pending.jsonl", [u("问"), a("答")]);
  const s = reducer(s0, {
    type: "latest_compaction",
    tabId: "t",
    sessionPath: "anchor-pending.jsonl",
    record: { inProgress: true },
  } as never);
  const list = s.items;
  const idx = list.findIndex((it) => it.kind === "compaction");
  ok(idx === list.length - 1, "压缩中卡片落在末尾");
}

process.stdout.write(`\ncompaction anchor restore: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
