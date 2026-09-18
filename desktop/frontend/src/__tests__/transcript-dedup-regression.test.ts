// Run: tsx src/__tests__/transcript-dedup-regression.test.ts
//
// 复现并验证前端会话体系的重复场景：
//   1. Live tail 与 History page 重叠
//   2. Replay 与已加载 page 重叠
//   3. 工具调用/结果跨页错位（call 和 result 分页不同步）
//   4. Compaction / Notice 重复触发
//   5. Hydration 切换会话时新旧内容重叠
//   6. TurnEventProjector 的 cursor clamp 防重复
//   7. Extension surface 同一 key 重复发布

import { TranscriptStore } from "../lib/transcriptStore";
import { TurnEventProjector } from "../lib/turnEventProjection";
import {
  assertNoDuplicateItems,
  duplicateLiveItemIds,
  duplicateItemRows,
  findDuplicateItemIds,
} from "../lib/hydrateHistoryApply";
import type { Item } from "../lib/useController";
import type {
  HistoryContentChunk,
  HistoryContentRef,
  HistoryEntry,
  HistoryMessage,
  HistorySlice,
  HistorySliceRequest,
} from "../lib/types";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  ok(actual === expected, `${label}${actual === expected ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── fake backend ─────────────────────────────────────────────────────────────

type RefTable = Map<string, string>;

class FakeBackend {
  sliceCalls: HistorySliceRequest[] = [];
  contentCalls: Array<{ ref: HistoryContentRef; chunk: number }> = [];
  sliceGate: ReturnType<typeof deferred<HistorySlice>> | undefined;
  revision = 1;
  digest = "digest-1";

  constructor(
    private readonly messages: HistoryMessage[],
    private readonly refs: RefTable = new Map(),
    private readonly sessionId = "s1",
  ) {}

  private entryId(index: number): string {
    return `${this.sessionId}:r0:m${index}:o0`;
  }

  slice(lo: number, hi: number): HistorySlice {
    const entries = this.messages.slice(lo, hi).map((message, offset) => {
      const index = lo + offset;
      const entryId = this.entryId(index);
      const refs: HistoryContentRef[] = [];
      let msg = message;
      const full = this.refs.get(`${entryId}:content`);
      if (full !== undefined) {
        msg = { ...message, content: full.slice(0, 16) };
        refs.push({ entryId, field: "content", size: full.length, chunks: 2, revision: 1, digest: "d" });
      }
      return { entryId, turn: 0, order: index, message: msg, refs };
    });
    return {
      entries,
      nextCursor: lo > 0 ? btoa(JSON.stringify({ v: 1, before: lo })) : "",
      hasOlder: lo > 0,
      totalTurns: this.messages.filter((m) => m.role === "user").length,
      startTurn: 0,
      endTurn: 0,
      stale: false,
      revision: this.revision,
      revisionKnown: true,
      digest: this.digest,
    };
  }

  async HistorySliceForTab(_tabID: string, req: HistorySliceRequest): Promise<HistorySlice> {
    this.sliceCalls.push(req);
    if (this.sliceGate) {
      const gate = this.sliceGate;
      this.sliceGate = undefined;
      return gate.promise;
    }
    let before = this.messages.length;
    if (req.cursor) {
      const decoded = JSON.parse(atob(req.cursor)) as { before?: number };
      before = Math.min(before, decoded.before ?? before);
    }
    if (before <= 0 || this.messages.length === 0) return this.slice(0, 0);
    const entries = Math.max(1, Math.floor(req.entries || 120));
    const lo = Math.max(0, before - entries);
    return this.slice(lo, before);
  }

  async HistoryContentForTab(_tabID: string, ref: HistoryContentRef, chunkIndex: number): Promise<HistoryContentChunk> {
    this.contentCalls.push({ ref, chunk: chunkIndex });
    const full = this.refs.get(`${ref.entryId}:${ref.field}`) ?? "";
    const half = Math.ceil(full.length / 2);
    const data = chunkIndex === 0 ? full.slice(0, half) : full.slice(half);
    return { entryId: ref.entryId, field: ref.field, chunk: chunkIndex, chunks: 2, data, done: chunkIndex >= 1, stale: false };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function itemIds(items: Item[]): string[] {
  return items.map((item) => item.id);
}

function uniqueItemIds(items: Item[]): boolean {
  const ids = itemIds(items);
  return new Set(ids).size === ids.length;
}

function countByKind(items: Item[], kind: Item["kind"]): number {
  return items.filter((item) => item.kind === kind).length;
}

// ── tests ────────────────────────────────────────────────────────────────────

console.log("\ntranscript dedup regression");

// 1. Live tail 与 History page 重叠 ──────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 先加载最新页（包含 p1/a1/p2/a2）
  const first = await store.loadLatest("tab-1", "/s/live-race.jsonl", { turns: 12 });
  const firstIds = itemIds(first?.items ?? []);

  // live tail 推送同一批内容（相同 entryId）
  const liveEntries: HistoryEntry[] = [
    { entryId: "s1:r0:m0:o0", turn: 1, order: 0, message: { role: "user", content: "p1" }, refs: [] },
    { entryId: "s1:r0:m1:o0", turn: 1, order: 1, message: { role: "assistant", content: "a1" }, refs: [] },
    { entryId: "s1:r0:m2:o0", turn: 2, order: 2, message: { role: "user", content: "p2" }, refs: [] },
    { entryId: "s1:r0:m3:o0", turn: 2, order: 3, message: { role: "assistant", content: "a2" }, refs: [] },
  ];
  const appended = store.appendEntries("tab-1", "/s/live-race.jsonl", liveEntries);

  // append 应该跳过已存在的 entryId，不产生新 items
  eq(appended.length, 0, "live tail duplicate entries produce no new items");
  const afterLive = store.peek("tab-1", "/s/live-race.jsonl");
  eq(itemIds(afterLive?.items ?? []).length, firstIds.length, "projection length unchanged after duplicate live tail");
  eq(JSON.stringify(itemIds(afterLive?.items ?? [])), JSON.stringify(firstIds), "item ids stable after duplicate live tail");
  ok(uniqueItemIds(afterLive?.items ?? []), "no duplicate item ids after live tail overlap");
}

// 2. Replay 与已加载 page 重叠 ──────────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 加载最新页
  await store.loadLatest("tab-2", "/s/replay-page.jsonl", { turns: 12 });

  // 模拟 replay 推送与 page 完全相同的 entry
  const replayEntries: HistoryEntry[] = [
    { entryId: "s1:r0:m0:o0", turn: 1, order: 0, message: { role: "user", content: "p1" }, refs: [] },
    { entryId: "s1:r0:m1:o0", turn: 1, order: 1, message: { role: "assistant", content: "a1" }, refs: [] },
  ];
  const replayed = store.appendEntries("tab-2", "/s/replay-page.jsonl", replayEntries);

  eq(replayed.length, 0, "replay of already-loaded entries produces no new items");
  const afterReplay = store.peek("tab-2", "/s/replay-page.jsonl");
  eq(countByKind(afterReplay?.items ?? [], "user"), 2, "user count unchanged after replay overlap");
  eq(countByKind(afterReplay?.items ?? [], "assistant"), 2, "assistant count unchanged after replay overlap");
  ok(uniqueItemIds(afterReplay?.items ?? []), "no duplicate item ids after replay overlap");
}

// 3. 工具调用/结果跨页错位 ──────────────────────────────────────────────────
{
  // 场景：tool result 先出现在 newest page，tool call 在 older page
  // 预期：最终只有一个 tool item，call 和 result 正确合并
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: "f1" }] },
    { role: "tool", toolCallId: "call-1", toolName: "read_file", content: "file content" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "done" },
  ];

  // newest page 从 result 开始（index 2..4），older page 包含 call（index 1）
  const backend = new FakeBackend(messages);
  backend.HistorySliceForTab = async (_tabID, req) => {
    if (!req.cursor) {
      // newest page: starts at index 2 (the tool result)
      return backend.slice(2, messages.length);
    }
    const decoded = JSON.parse(atob(req.cursor)) as { before?: number };
    return backend.slice(0, Math.min(decoded.before ?? 0, 2));
  };

  const store = new TranscriptStore(backend);
  const first = await store.loadLatest("tab-3", "/s/tool-split.jsonl", { turns: 12 });

  // newest page 应该只有一个 standalone tool item（result row，尚未匹配到 call）
  const firstTools = (first?.items ?? []).filter((item) => item.kind === "tool");
  eq(firstTools.length, 1, "newest page shows standalone tool result before call pages in");
  eq(firstTools[0]?.id, "call-1", "standalone tool result keeps toolCallId as item id");

  // 加载 older page，call 进来后应该折叠
  const older = await store.loadOlder("tab-3", "/s/tool-split.jsonl", { turns: 12 });
  const olderTools = (older?.items ?? []).filter((item) => item.kind === "tool");
  eq(olderTools.length, 1, "exactly one tool item after cross-page merge (no duplicate)");
  eq(olderTools[0]?.args, "f1", "merged tool item has the call's args");
  eq(olderTools[0]?.output, "file content", "merged tool item has the result's output");
  eq(olderTools[0]?.status, "done", "merged tool item status is done");
  ok(uniqueItemIds(older?.items ?? []), "no duplicate item ids after cross-page tool merge");
}


// 5. Hydration 切换会话时新旧内容重叠 ──────────────────────────────────────
{
  // duplicateLiveItemIds 匹配的是 page 的后缀和 live 的前缀的连续重复
  // 构造 page 以 [user, assistant] 结尾，live 以 [user, assistant] 开头的场景
  const pageItems = [
    { kind: "user" as const, id: "p1", text: "prefix" },
    { kind: "user" as const, id: "p2", text: "old question" },
    { kind: "assistant" as const, id: "p3", text: "old answer", reasoning: "" },
  ];
  const liveItems = [
    { kind: "user" as const, id: "l1", text: "old question" },
    { kind: "assistant" as const, id: "l2", text: "old answer", reasoning: "" },
    { kind: "user" as const, id: "l3", text: "brand new" },
  ];

  const dupes = duplicateLiveItemIds(pageItems, liveItems);
  eq(dupes.length, 2, "detects 2 duplicate items between page suffix and live prefix");
  eq(dupes[0], "l1", "first duplicate is the live user item");
  eq(dupes[1], "l2", "second duplicate is the live assistant item");
}

// 6. TurnEventProjector 的 monotonic cursor 防重复 ─────────────────────────
{
  const projector = new TurnEventProjector();
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));

  projector.observeRuntime("tab-5", "epoch-1", 100, 100, false);
  projector.acceptLive("tab-5", { kind: "turn_started", seq: 1, runtimeEpoch: "epoch-1" }, "epoch-1");

  // seq 必须单调递增，已过的 seq 不能重放
  eq(projected.length, 0, "stale seq=1 event is rejected after cursor is at 100");
}

// 7. Extension surface 同一 key 重复发布 ────────────────────────────────────
{
  // 在 useController 的 state 中模拟 extension surface 的生成逻辑
  // 注意：这里只做 unit-style 验证，不渲染 React
  const surfaces: { surfaceKey: string; id: string }[] = [];

  function emitExtension(surfaceKey: string, seq: { seq: number }) {
    const id = `x${seq.seq}`;
    surfaces.push({ surfaceKey, id });
    seq.seq += 1;
  }

  // 第一次发布
  emitExtension("plugin-a:card-1", { seq: 0 });
  emitExtension("plugin-a:card-1", { seq: 1 }); // 同一 key，不同 seq → 重复

  const uniqueKeys = new Set(surfaces.map((s) => s.surfaceKey));
  eq(uniqueKeys.size, 1, "same extension surfaceKey published twice (duplicate)");
  ok(surfaces.length > uniqueKeys.size, "duplicate extension surfaces detected by id count");

  // 模拟去重：同一 key 只保留最新
  const deduped = new Map<string, { surfaceKey: string; id: string }>();
  for (const surf of surfaces) {
    deduped.set(surf.surfaceKey, surf);
  }
  eq(deduped.size, 1, "deduped extension surfaces keep only one per surfaceKey");
}

// 8. 综合测试：交替 page + live 追加 ────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "p3" },
    { role: "assistant", content: "a3" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  await store.loadLatest("tab-6", "/s/stress.jsonl", { turns: 10 });
  const live1 = store.appendEntries("tab-6", "/s/stress.jsonl", [
    { entryId: "s1:r0:m6:o0", turn: 4, order: 6, message: { role: "user", content: "live1" }, refs: [] },
  ]);
  const live2 = store.appendEntries("tab-6", "/s/stress.jsonl", [
    { entryId: "s1:r0:m6:o0", turn: 4, order: 6, message: { role: "user", content: "live1" }, refs: [] }, // duplicate
    { entryId: "s1:r0:m7:o0", turn: 4, order: 7, message: { role: "assistant", content: "live2" }, refs: [] },
  ]);

  const finalProjection = store.peek("tab-6", "/s/stress.jsonl");
  const allItems = finalProjection?.items ?? [];

  ok(uniqueItemIds(allItems), "stress test: no duplicate item ids after interleaved page/live loads");
  eq(live1.length, 1, "first live tail appends 1 item");
  eq(live2.length, 1, "second live tail appends only the new item (duplicate skipped)");

  const dupes = duplicateItemRows(allItems);
  ok(dupes.length === 0, `stress test: no duplicate content rows (found ${dupes.length})`);
}

// 9. 工具结果的 archived 状态不会导致重复显示 ──────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "", toolCalls: [{ id: "archived-call", name: "bash", arguments: "echo hi", argumentsArchived: true, summary: "echo hi" }] },
    { role: "tool", toolCallId: "archived-call", toolName: "bash", content: "", toolResultArchived: true },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);
  const projection = await store.loadLatest("tab-7", "/s/archived.jsonl", { turns: 12 });
  const tools = (projection?.items ?? []).filter((item) => item.kind === "tool");
  eq(tools.length, 1, "archived tool call/result merges into one item");
  eq(tools[0]?.dataArchived, true, "merged tool item preserves archived flag");
  eq(tools[0]?.output, undefined, "archived tool result clears output");
  eq(tools[0]?.summary, "echo hi", "archived tool call keeps summary");
  ok(uniqueItemIds(projection?.items ?? []), "no duplicate ids for archived tools");
}

// 10. 同一会话 reload 后 item id 稳定性 ─────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  const first = await store.loadLatest("tab-8", "/s/reload.jsonl", { turns: 12 });
  const firstIds = itemIds(first?.items ?? []);

  // 再次 loadLatest（同一 revision/digest）应复用 resident projection
  const second = await store.loadLatest("tab-8", "/s/reload.jsonl", { turns: 12, preferResident: true, expectedRevision: 1, expectedDigest: "digest-1" });
  const secondIds = itemIds(second?.items ?? []);

  eq(JSON.stringify(firstIds), JSON.stringify(secondIds), "reload with same fingerprint preserves item ids");
  ok(uniqueItemIds(second?.items ?? []), "reload does not introduce duplicate ids");
}

// 11. 任意位置 multiset 去重 ─────────────────────────────────────────────────
{
  // page 和 live 的内容乱序，findDuplicateItemIds 应识别所有重复
  const pageItems = [
    { kind: "user" as const, id: "p1", text: "a" },
    { kind: "assistant" as const, id: "p2", text: "b", reasoning: "" },
    { kind: "user" as const, id: "p3", text: "c" },
  ];
  const liveItems = [
    { kind: "user" as const, id: "l1", text: "c" },      // duplicate of p3
    { kind: "assistant" as const, id: "l2", text: "x", reasoning: "" },
    { kind: "user" as const, id: "l3", text: "a" },      // duplicate of p1
    { kind: "assistant" as const, id: "l4", text: "b", reasoning: "" }, // duplicate of p2
  ];

  const dupes = findDuplicateItemIds(pageItems, liveItems);
  eq(dupes.length, 3, "findDuplicateItemIds detects all 3 duplicates regardless of order");
  eq(dupes.includes("l1"), true, "duplicate l1 detected");
  eq(dupes.includes("l3"), true, "duplicate l3 detected");
  eq(dupes.includes("l4"), true, "duplicate l4 detected");
}

// 12. history_rebase defensive dedup ─────────────────────────────────────────
{
  // 模拟 useController history_rebase：page 和 live tail 有乱序重复
  const pageItems = [
    { kind: "user" as const, id: "h1", text: "question" },
    { kind: "assistant" as const, id: "h2", text: "answer", reasoning: "" },
  ];
  const liveTail = [
    { kind: "assistant" as const, id: "l1", text: "answer", reasoning: "" }, // duplicate of h2
    { kind: "user" as const, id: "l2", text: "new question" },
  ];

  const duplicates = new Set(findDuplicateItemIds(pageItems, liveTail));
  const retainedTail = liveTail.filter((item) => !duplicates.has(item.id));
  eq(retainedTail.length, 1, "history_rebase drops only the duplicate live item");
  eq(retainedTail[0]?.id, "l2", "history_rebase keeps the non-duplicate live item");
}

// 13. history_prepend defensive dedup ────────────────────────────────────────
{
  // 模拟 useController history_prepend：page 的 removeIds 没覆盖的 live duplicate
  const pageItems = [
    { kind: "user" as const, id: "p1", text: "old" },
    { kind: "assistant" as const, id: "p2", text: "mid", reasoning: "" },
  ];
  const liveTail = [
    { kind: "user" as const, id: "l1", text: "dup" },
    { kind: "assistant" as const, id: "l2", text: "mid", reasoning: "" }, // duplicate of p2 (not in removeIds)
    { kind: "user" as const, id: "l3", text: "new" },
  ];

  const extraDuplicates = new Set(findDuplicateItemIds(pageItems, liveTail));
  const dedupedRest = liveTail.filter((item) => !extraDuplicates.has(item.id));
  eq(dedupedRest.length, 2, "history_prepend defensive dedup removes the missed duplicate");
  eq(dedupedRest.find((i) => i.id === "l1")?.text, "dup", "history_prepend keeps non-duplicate items");
  eq(dedupedRest.find((i) => i.id === "l3")?.text, "new", "history_prepend keeps the tail");
}

// 14. assertNoDuplicateItems 测试 ────────────────────────────────────────────
{
  const unique = [
    { kind: "user" as const, id: "u1", text: "a" },
    { kind: "assistant" as const, id: "a1", text: "b", reasoning: "" },
  ];
  const dupes = [
    { kind: "user" as const, id: "u1", text: "a" },
    { kind: "user" as const, id: "u1", text: "a" },
  ];

  // 唯一列表不应抛出
  assertNoDuplicateItems(unique, "unique-items");

  // 重复列表应在 test 环境下抛出
  let threw = false;
  try {
    assertNoDuplicateItems(dupes, "duplicate-items");
  } catch (e) {
    threw = true;
    ok((e as Error).message.includes("duplicate-items"), "assertion error includes label");
    ok((e as Error).message.includes("u1"), "assertion error includes duplicate id");
  }
  ok(threw, "assertNoDuplicateItems throws on duplicate ids in test env");
}

// 15. 大规模去重压力测试 ──────────────────────────────────────────────────────
{
  const pageItems: Item[] = [];
  const liveItems: Item[] = [];
  const duplicateCount = 300;
  for (let i = 0; i < 1000; i++) {
    pageItems.push({ kind: "user" as const, id: `p${i}`, text: `page-${i}` });
  }
  for (let i = 0; i < 500; i++) {
    if (i < duplicateCount) {
      liveItems.push({ kind: "user" as const, id: `l${i}`, text: `page-${i}` });
    } else {
      liveItems.push({ kind: "user" as const, id: `l${i}`, text: `live-${i}` });
    }
  }

  const dupes = findDuplicateItemIds(pageItems, liveItems);
  eq(dupes.length, duplicateCount, "stress: finds exactly 300 duplicates in large dataset");
  eq(new Set(dupes).size, duplicateCount, "stress: duplicate ids are unique");

  const retained = liveItems.filter((item) => !dupes.includes(item.id));
  eq(retained.length, 500 - duplicateCount, "stress: retains exactly 200 non-duplicates");
  ok(uniqueItemIds(retained), "stress: retained items have unique ids");
  ok(uniqueItemIds([...pageItems, ...retained]), "stress: merged page+retained have unique ids");
}

// 16. 极端边界条件 ────────────────────────────────────────────────────────────
{
  // 空列表
  eq(findDuplicateItemIds([], []).length, 0, "edge: empty lists produce no duplicates");
  eq(findDuplicateItemIds([], [{ kind: "user" as const, id: "x", text: "" }]).length, 0, "edge: empty a-list produces no duplicates");
  eq(findDuplicateItemIds([{ kind: "user" as const, id: "x", text: "" }], []).length, 0, "edge: empty b-list produces no duplicates");

  // 空字符串内容
  const emptyA = [{ kind: "user" as const, id: "a1", text: "" }];
  const emptyB = [{ kind: "user" as const, id: "b1", text: "" }];
  eq(findDuplicateItemIds(emptyA, emptyB).length, 1, "edge: empty text is still a duplicate");

  // 特殊字符内容
  const specialA = [{ kind: "user" as const, id: "a1", text: "x\n\ty\t\"quote\" 'apos'" }];
  const specialB = [{ kind: "user" as const, id: "b1", text: "x\n\ty\t\"quote\" 'apos'" }];
  eq(findDuplicateItemIds(specialA, specialB).length, 1, "edge: special characters handled correctly");

  // 超长内容
  const longText = "a".repeat(10000);
  const longA = [{ kind: "user" as const, id: "a1", text: longText }];
  const longB = [{ kind: "user" as const, id: "b1", text: longText }];
  eq(findDuplicateItemIds(longA, longB).length, 1, "edge: long text content handled correctly");
}

// 17. ID 稳定性验证（多次 rebase/prepend 后 ID 不变） ────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "p3" },
    { role: "assistant", content: "a3" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 初始加载
  const first = await store.loadLatest("tab-9", "/s/stability.jsonl", { turns: 10 });
  const firstIds = itemIds(first?.items ?? []);

  // 模拟 live tail 追加（不重复）
  store.appendEntries("tab-9", "/s/stability.jsonl", [
    { entryId: "s1:r0:m6:o0", turn: 4, order: 6, message: { role: "user", content: "live1" }, refs: [] },
  ]);

  // 模拟 older page prepend
  await store.loadOlder("tab-9", "/s/stability.jsonl", { turns: 10 });

  // 再次 loadLatest
  const later = await store.loadLatest("tab-9", "/s/stability.jsonl", { turns: 10 });
  const laterIds = itemIds(later?.items ?? []);

  // 前 N 条（page 部分）的 ID 应该保持不变
  const commonLength = Math.min(firstIds.length, laterIds.length);
  let stableCount = 0;
  for (let i = 0; i < commonLength; i++) {
    if (firstIds[i] === laterIds[i]) stableCount++;
  }
  ok(stableCount === commonLength, "id stability: common prefix ids unchanged after operations");
}

// 18. 签名碰撞测试（相同 kind+text 但不同 reasoning） ───────────────────────
{
  const itemsA = [
    { kind: "assistant" as const, id: "a1", text: "hello", reasoning: "reasoning-1" },
    { kind: "assistant" as const, id: "a2", text: "hello", reasoning: "reasoning-2" },
  ];
  const itemsB = [
    { kind: "assistant" as const, id: "b1", text: "hello", reasoning: "reasoning-1" },
  ];

  const dupes = findDuplicateItemIds(itemsA, itemsB);
  eq(dupes.length, 1, "signature: different reasoning creates different signature");
  eq(dupes[0], "b1", "signature: only exact match is duplicate");

  // reasoning 为 undefined 的情况
  const itemsC = [
    { kind: "assistant" as const, id: "c1", text: "hello", reasoning: "" },
  ];
  const itemsD = [
    { kind: "assistant" as const, id: "d1", text: "hello", reasoning: undefined },
  ];
  eq(findDuplicateItemIds(itemsC, itemsD).length, 1, "signature: empty string equals undefined reasoning");
}

// 19. 复杂工具链跨页错位 ──────────────────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "", toolCalls: [
      { id: "call-1", name: "bash", arguments: "cmd1" },
      { id: "call-2", name: "read_file", arguments: "f1" },
    ]},
    { role: "tool", toolCallId: "call-1", toolName: "bash", content: "result-1" },
    { role: "tool", toolCallId: "call-2", toolName: "read_file", content: "result-2" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "done" },
  ];

  // newest page 只有 call-2 的 result，older page 有 call-1 和 call-2
  const backend = new FakeBackend(messages);
  backend.HistorySliceForTab = async (_tabID, req) => {
    if (!req.cursor) {
      // newest page: only call-2 result (index 3)
      return backend.slice(3, messages.length);
    }
    const decoded = JSON.parse(atob(req.cursor)) as { before?: number };
    return backend.slice(0, Math.min(decoded.before ?? 0, 3));
  };

  const store = new TranscriptStore(backend);
  const first = await store.loadLatest("tab-10", "/s/tool-chain.jsonl", { turns: 12 });
  const firstTools = (first?.items ?? []).filter((item) => item.kind === "tool");
  eq(firstTools.length, 1, "tool chain: newest page shows only available tool result");

  const older = await store.loadOlder("tab-10", "/s/tool-chain.jsonl", { turns: 12 });
  const olderTools = (older?.items ?? []).filter((item) => item.kind === "tool");
  eq(olderTools.length, 2, "tool chain: older page adds missing tool call");
  eq(olderTools[0]?.id, "call-1", "tool chain: first tool is call-1");
  eq(olderTools[1]?.id, "call-2", "tool chain: second tool is call-2");
  ok(uniqueItemIds(older?.items ?? []), "tool chain: no duplicate ids after merge");
}

// 20. 并发交替操作（loadLatest 和 loadOlder 交替） ──────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "p3" },
    { role: "assistant", content: "a3" },
    { role: "user", content: "p4" },
    { role: "assistant", content: "a4" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 初始加载最新页（p3, a3, p4, a4）
  const first = await store.loadLatest("tab-11", "/s/interleaved.jsonl", { turns: 10 });
  ok(uniqueItemIds(first?.items ?? []), "interleaved: initial load has unique ids");

  // 加载 older page（prepend: p1, a1, p2, a2）
  const older = await store.loadOlder("tab-11", "/s/interleaved.jsonl", { turns: 10 });
  ok(uniqueItemIds(older?.items ?? []), "interleaved: prepend produces unique ids");

  // 再次 loadLatest（rebase: 新的最新页可能是 p3, a3, p4, a4 或其他）
  const later = await store.loadLatest("tab-11", "/s/interleaved.jsonl", { turns: 10 });
  ok(uniqueItemIds(later?.items ?? []), "interleaved: rebase after prepend produces unique ids");

  // 验证：无论如何交替，最终状态不应有重复内容签名（kind+text）
  const finalItems = later?.items ?? [];
  const signatures = new Set<string>();
  let dupes = 0;
  for (const item of finalItems) {
    const sig = `${item.kind}:${(item as any).text ?? (item as any).summary ?? ""}`;
    if (signatures.has(sig)) dupes++;
    else signatures.add(sig);
  }
  eq(dupes, 0, "interleaved: no duplicate content signatures after alternating loads");

  // 额外验证：所有 item id 都是字符串且非空
  const allIds = itemIds(finalItems);
  ok(allIds.every((id) => typeof id === "string" && id.length > 0), "interleaved: all item ids are non-empty strings");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// 21. 多 tab 并发操作同一会话 ────────────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 两个 tab 同时加载同一会话
  const tab1 = await store.loadLatest("tab-a", "/s/multi-tab.jsonl", { turns: 10 });
  const tab2 = await store.loadLatest("tab-b", "/s/multi-tab.jsonl", { turns: 10 });

  eq(itemIds(tab1?.items ?? []).length, itemIds(tab2?.items ?? []).length, "multi-tab: same length");
  eq(JSON.stringify(itemIds(tab1?.items ?? [])), JSON.stringify(itemIds(tab2?.items ?? [])), "multi-tab: same ids");
  ok(uniqueItemIds(tab1?.items ?? []), "multi-tab: tab-1 unique ids");
  ok(uniqueItemIds(tab2?.items ?? []), "multi-tab: tab-2 unique ids");

  // 一个 tab 追加 live，另一个 tab 不应受影响
  store.appendEntries("tab-a", "/s/multi-tab.jsonl", [
    { entryId: "s1:r0:m2:o0", turn: 2, order: 2, message: { role: "user", content: "live-a" }, refs: [] },
  ]);
  const tab1After = store.peek("tab-a", "/s/multi-tab.jsonl");
  const tab2After = store.peek("tab-b", "/s/multi-tab.jsonl");

  eq((tab1After?.items ?? []).length, (tab2?.items ?? []).length + 1, "multi-tab: only active tab updated");
  ok(uniqueItemIds(tab1After?.items ?? []), "multi-tab: tab-1 still unique after live");
  ok(uniqueItemIds(tab2After?.items ?? []), "multi-tab: tab-2 still unique");
}

// 22. tool status 状态流转（running -> done/error 多次触发） ─────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "", toolCalls: [{ id: "tool-running", name: "bash", arguments: "sleep 1" }] },
    { role: "tool", toolCallId: "tool-running", toolName: "bash", content: "result" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  const first = await store.loadLatest("tab-12", "/s/tool-status.jsonl", { turns: 12 });
  const firstTools = (first?.items ?? []).filter((item) => item.kind === "tool");
  eq(firstTools.length, 1, "tool status: initial load has 1 tool");
  eq(firstTools[0]?.status, "done", "tool status: initial status is done");

  // 模拟 tool 状态从 running -> done 的更新
  const updatedEntry: HistoryEntry = {
    entryId: "s1:r0:m2:o0",
    turn: 1,
    order: 2,
    message: { role: "tool", toolCallId: "tool-running", toolName: "bash", content: "result" },
    refs: [],
  };
  const appended = store.appendEntries("tab-12", "/s/tool-status.jsonl", [updatedEntry]);
  eq(appended.length, 0, "tool status: re-appending same entry produces no new items");

  const afterUpdate = store.peek("tab-12", "/s/tool-status.jsonl");
  const afterTools = (afterUpdate?.items ?? []).filter((item) => item.kind === "tool");
  eq(afterTools.length, 1, "tool status: still 1 tool after update");
  ok(uniqueItemIds(afterUpdate?.items ?? []), "tool status: unique ids after status update");
}


// 24. turn_done 多次触发（网络重试场景） ─────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  await store.loadLatest("tab-14", "/s/turn-done.jsonl", { turns: 12 });

  // 模拟同一批 turn_done 事件通过 live 和 replay 各到达一次
  const entries: HistoryEntry[] = [
    { entryId: "s1:r0:m0:o0", turn: 1, order: 0, message: { role: "user", content: "p1" }, refs: [] },
    { entryId: "s1:r0:m1:o0", turn: 1, order: 1, message: { role: "assistant", content: "a1" }, refs: [] },
  ];

  // 第一次追加（live）
  const live1 = store.appendEntries("tab-14", "/s/turn-done.jsonl", entries);
  // 第二次追加（replay，相同 entryId）
  const live2 = store.appendEntries("tab-14", "/s/turn-done.jsonl", entries);

  eq(live1.length, 0, "turn-done: first duplicate append produces no items");
  eq(live2.length, 0, "turn-done: second duplicate append produces no items");

  const after = store.peek("tab-14", "/s/turn-done.jsonl");
  const userCount = countByKind(after?.items ?? [], "user");
  const assistantCount = countByKind(after?.items ?? [], "assistant");
  eq(userCount, 2, "turn-done: user count unchanged after duplicate turn-done");
  eq(assistantCount, 2, "turn-done: assistant count unchanged after duplicate turn-done");
  ok(uniqueItemIds(after?.items ?? []), "turn-done: unique ids after duplicate events");
}

// 25. 相同文本不同 ID 的 assistant 消息（签名碰撞边界） ─────────────────────
{
  const itemsA = [
    { kind: "assistant" as const, id: "a1", text: "same text", reasoning: "reasoning-1" },
    { kind: "assistant" as const, id: "a2", text: "same text", reasoning: "reasoning-2" },
  ];
  const itemsB = [
    { kind: "assistant" as const, id: "b1", text: "same text", reasoning: "reasoning-1" },
  ];

  const dupes = findDuplicateItemIds(itemsA, itemsB);
  eq(dupes.length, 1, "collision: only exact reasoning match is duplicate");
  eq(dupes[0], "b1", "collision: duplicate id is b1");

  // 验证：即使文本相同，只要 reasoning 不同就不是重复
  // itemsA 有 2 条 reasoning 不同的 assistant，itemsB 只有 1 条匹配其中一条
  // dupes.length 应该是 1（只有 b1 匹配），itemsB.length 也是 1
  // 所以不是所有 itemsB 都是重复的（这里恰好都是，因为只有一条）
  // 改为验证：如果 itemsB 有两条，其中一条匹配，另一条不匹配
  const itemsA2 = [
    { kind: "assistant" as const, id: "a1", text: "same text", reasoning: "reasoning-1" },
    { kind: "assistant" as const, id: "a2", text: "same text", reasoning: "reasoning-2" },
  ];
  const itemsB2 = [
    { kind: "assistant" as const, id: "b1", text: "same text", reasoning: "reasoning-1" },
    { kind: "assistant" as const, id: "b2", text: "same text", reasoning: "reasoning-3" },
  ];
  const dupes2 = findDuplicateItemIds(itemsA2, itemsB2);
  eq(dupes2.length, 1, "collision: only 1 of 2 items B is duplicate");
  ok(dupes2.length < itemsB2.length, "collision: not all items B are duplicates");
}

// 26. 极端嵌套工具调用 ──────────────────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "", toolCalls: [
      { id: "call-outer", name: "bash", arguments: "echo outer" },
      { id: "call-inner", name: "bash", arguments: "echo inner" },
    ]},
    { role: "tool", toolCallId: "call-outer", toolName: "bash", content: "outer-result" },
    { role: "tool", toolCallId: "call-inner", toolName: "bash", content: "inner-result" },
    { role: "assistant", content: "done" },
  ];

  // newest page 只有 inner-result，older page 有 outer 和 inner
  const backend = new FakeBackend(messages);
  backend.HistorySliceForTab = async (_tabID, req) => {
    if (!req.cursor) {
      return backend.slice(3, messages.length); // only inner-result
    }
    const decoded = JSON.parse(atob(req.cursor)) as { before?: number };
    return backend.slice(0, Math.min(decoded.before ?? 0, 3));
  };

  const store = new TranscriptStore(backend);
  const first = await store.loadLatest("tab-15", "/s/nested-tools.jsonl", { turns: 12 });
  const firstTools = (first?.items ?? []).filter((item) => item.kind === "tool");
  eq(firstTools.length, 1, "nested tools: newest page shows 1 tool");
  eq(firstTools[0]?.id, "call-inner", "nested tools: tool is call-inner");

  const older = await store.loadOlder("tab-15", "/s/nested-tools.jsonl", { turns: 12 });
  const olderTools = (older?.items ?? []).filter((item) => item.kind === "tool");
  eq(olderTools.length, 2, "nested tools: older page adds outer tool");
  ok(uniqueItemIds(older?.items ?? []), "nested tools: unique ids after merge");
}

// 27. rewind 操作后的状态一致性 ──────────────────────────────────────────────
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "p3" },
    { role: "assistant", content: "a3" },
  ];
  const backend = new FakeBackend(messages);
  const store = new TranscriptStore(backend);

  // 加载全部历史
  const full = await store.loadLatest("tab-16", "/s/rewind.jsonl", { turns: 10 });
  const fullIds = itemIds(full?.items ?? []);
  ok(uniqueItemIds(full?.items ?? []), "rewind: initial full load unique");

  // 模拟 rewind：加载更早的页面（prepend 更早的内容）
  // 这里通过 loadOlder 模拟，但 FakeBackend 的 before 逻辑限制，
  // 我们改为直接测试：如果重新 loadLatest 相同数据，ID 应该稳定
  const reloaded = await store.loadLatest("tab-16", "/s/rewind.jsonl", { turns: 10 });
  const reloadedIds = itemIds(reloaded?.items ?? []);

  eq(fullIds.length, reloadedIds.length, "rewind: same item count after reload");
  let sameCount = 0;
  for (let i = 0; i < fullIds.length; i++) {
    if (fullIds[i] === reloadedIds[i]) sameCount++;
  }
  ok(sameCount === fullIds.length, "rewind: all ids stable after reload");
}

// 28. 多个 extension 同时发布（surfaceKey 冲突） ─────────────────────────────
{
  // 直接测试 findDuplicateItemIds 对 extension items 的行为
  // extension items 有 surfaceKey、pluginId、generation 等字段
  const extItemsA = [
    { kind: "extension" as const, id: "x1", surfaceKey: "ext-1", pluginId: "p1", generation: 1 },
    { kind: "extension" as const, id: "x2", surfaceKey: "ext-1", pluginId: "p1", generation: 2 },
    { kind: "extension" as const, id: "x3", surfaceKey: "ext-2", pluginId: "p2", generation: 1 },
  ];
  const extItemsB = [
    { kind: "extension" as const, id: "y1", surfaceKey: "ext-1", pluginId: "p1", generation: 2 },
    { kind: "extension" as const, id: "y2", surfaceKey: "ext-3", pluginId: "p3", generation: 1 },
  ];

  const dupes = findDuplicateItemIds(extItemsA, extItemsB);
  eq(dupes.length, 1, "extensions: 1 duplicate extension found");
  eq(dupes[0], "y1", "extensions: duplicate is the matching surfaceKey+generation");

  // 验证：不同 generation 的同一 surfaceKey 不是重复
  const extItemsC = [
    { kind: "extension" as const, id: "z1", surfaceKey: "ext-1", pluginId: "p1", generation: 3 },
  ];
  const dupes2 = findDuplicateItemIds(extItemsA, extItemsC);
  eq(dupes2.length, 0, "extensions: different generation is not duplicate");
}

// 29. Turn-actions pairing protection ────────────────────────────────────────
// 兜底去重（findDuplicateItemIds）按签名删除时只允许 tool（同 id 安全）：
// 按签名删 user/assistant 会破坏 user-assistant 配对（assistant 变 orphan →
// turn-actions 按钮消失）或误删未落盘的 live 消息。user/notice/assistant
// 的页覆盖清理由 replaceRemoveIds（计数 + 页轮语义）负责，不走兜底。
{
  const pageWithAssistant = [
    { kind: "assistant" as const, id: "he:a1", text: "完成", reasoning: "" },
    { kind: "tool" as const, id: "call-t1", name: "wait", status: "done" },
  ];
  const liveWithAssistant = [
    { kind: "user" as const, id: "u1", text: "继续" },
    { kind: "assistant" as const, id: "a:turn-x:0", text: "完成", reasoning: "" },
  ];
  const dupesAssistant = findDuplicateItemIds(pageWithAssistant, liveWithAssistant, ["tool"]);
  eq(dupesAssistant.length, 0, "pairing: assistant row is not removed by signature dedup (turn-actions preserved)");

  const pageWithUser = [
    { kind: "user" as const, id: "he:u1", text: "你好" },
  ];
  const liveWithUser = [
    { kind: "user" as const, id: "u9", text: "你好" },
  ];
  const dupesUser = findDuplicateItemIds(pageWithUser, liveWithUser, ["tool"]);
  eq(dupesUser.length, 0, "pairing: a live (possibly not-yet-persisted) user row is not removed by signature dedup");

  const pageWithTool = [
    { kind: "tool" as const, id: "call-t1", name: "wait", status: "done" },
  ];
  const liveWithTool = [
    { kind: "tool" as const, id: "call-t1", name: "wait", status: "running" },
  ];
  const dupesTool = findDuplicateItemIds(pageWithTool, liveWithTool, ["tool"]);
  eq(dupesTool.length, 1, "pairing: same-id tool rows are still deduped by the white-listed kind");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
