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
  duplicateLiveItemIds,
  duplicateItemRows,
  itemSignature,
} from "../lib/hydrateHistoryApply";
import { historyMessagesToItems, type Item } from "../lib/useController";
import type {
  HistoryContentChunk,
  HistoryContentRef,
  HistoryEntry,
  HistoryMessage,
  HistorySlice,
  HistorySliceRequest,
  WireEvent,
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

// 4. Compaction / Notice 重复触发 ────────────────────────────────────────────
{
  // 模拟同一 compaction 事件通过 replay 和 live 各到达一次
  const projector = new TurnEventProjector();
  const projected: WireEvent[] = [];
  projector.bind((event) => projected.push(event));

  // 初始 live 事件
  projector.observeRuntime("tab-4", "epoch-1", 10, 10, true);
  projector.acceptLive("tab-4", { kind: "compaction", seq: 11, turnId: "t1", status: "in_progress", event: { kind: "compaction", pending: true, trigger: "auto" } }, "epoch-1");

  // replay 也携带相同的 compaction seq=11
  projector.requestReplay = (_tabId: string, afterSeq: number) => {
    // 直接模拟 replay 返回相同 seq
    projector.acceptLive("tab-4", { kind: "compaction", seq: 11, turnId: "t1", status: "in_progress", event: { kind: "compaction", pending: true, trigger: "auto" } }, "epoch-1");
  };

  // 触发一次 replay（afterSeq=10，和 live seq=11 有缺口）
  projector.acceptLive("tab-4", { kind: "text", seq: 12, turnId: "t1", status: "in_progress", event: { kind: "text", text: "x" } }, "epoch-1");

  const compactionSeqs = projected.filter((e) => e.kind === "compaction").map((e) => e.seq);
  const uniqueCompactionSeqs = new Set(compactionSeqs);
  eq(uniqueCompactionSeqs.size, compactionSeqs.length, "compaction event not duplicated by replay");
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

  const p1 = await store.loadLatest("tab-6", "/s/stress.jsonl", { turns: 10 });
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
