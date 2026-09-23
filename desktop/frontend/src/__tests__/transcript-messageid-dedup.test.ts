// Run: tsx src/__tests__/transcript-messageid-dedup.test.ts
//
// Verifies the A1 layer: a stable per-message id (messageId) dedupes rows whose
// entryId re-keyed across a rewrite/rewind (entryId is position + revision
// derived, so it changes; messageId does not).

import { TranscriptStore } from "../lib/transcriptStore";
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

function uniqueIds(items: { id: string }[]): boolean {
  const ids = items.map((it) => it.id);
  return new Set(ids).size === ids.length;
}

function mkEntry(i: number, rev: number, message: HistoryMessage, messageId?: string): HistoryEntry {
  return {
    entryId: `s1:r${rev}:m${i}:o0`,
    messageId,
    turn: 0,
    order: i,
    message,
    refs: [] as HistoryContentRef[],
  };
}

class FakeBackend {
  constructor(
    private readonly messages: HistoryMessage[],
    private readonly rev = 0,
    private readonly withMessageId = true,
  ) {}

  async HistorySliceForTab(_tabID: string, _req: HistorySliceRequest): Promise<HistorySlice> {
    const entries = this.messages.map((m, i) => mkEntry(i, this.rev, m, this.withMessageId ? `mid-${i}` : undefined));
    return {
      entries,
      nextCursor: "",
      hasOlder: false,
      totalTurns: 0,
      startTurn: 0,
      endTurn: 0,
      stale: false,
      revision: this.rev + 1,
      revisionKnown: true,
      digest: `d-${this.rev}`,
    };
  }

  async HistoryContentForTab(_tabID: string, ref: HistoryContentRef, chunkIndex: number): Promise<HistoryContentChunk> {
    return { entryId: ref.entryId, field: ref.field, chunk: chunkIndex, chunks: 1, data: "", done: true, stale: false };
  }
}

console.log("\ntranscript messageId dedup");

// 1. append rewind rows (same messageId, new entryId) are skipped
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  const backend = new FakeBackend(messages, 0);
  const store = new TranscriptStore(backend);
  const latest = await store.loadLatest("tab-1", "/s/rewind.jsonl", { turns: 12 });
  eq(latest?.items.length, 2, "initial load has 2 items");

  // rewind: same messages land under revision 1 → new entryId, same messageId
  const rewindRows = messages.map((m, i) => mkEntry(i, 1, m, `mid-${i}`));
  const appended = store.appendEntries("tab-1", "/s/rewind.jsonl", rewindRows);
  eq(appended.length, 0, "rewind rows (same messageId, new entryId) are skipped");
  const after = store.peek("tab-1", "/s/rewind.jsonl");
  eq(after?.items.length, 2, "item count unchanged after rewind re-key");
  ok(uniqueIds(after?.items ?? []), "no duplicate ids after rewind re-key");
}

// 2. mixed: one already-resident row (new entryId) + one genuinely new row
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  const backend = new FakeBackend(messages, 0);
  const store = new TranscriptStore(backend);
  await store.loadLatest("tab-2", "/s/mixed.jsonl", { turns: 12 });

  const tail = [
    mkEntry(0, 1, messages[0], "mid-0"), // already resident (re-keyed)
    mkEntry(1, 1, messages[1], "mid-1"), // already resident (re-keyed)
    mkEntry(2, 1, { role: "user", content: "q2" }, "mid-2"), // genuinely new
  ];
  const appended = store.appendEntries("tab-2", "/s/mixed.jsonl", tail);
  eq(appended.length, 1, "only the genuinely new row is appended");
  const after = store.peek("tab-2", "/s/mixed.jsonl");
  eq(after?.items.length, 3, "item count reflects the single new row");
  ok(uniqueIds(after?.items ?? []), "no duplicate ids in mixed append");
}

// 3. legacy rows (no messageId) still dedupe by entryId only
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  const backend = new FakeBackend(messages, 0, false); // legacy: no messageId
  const store = new TranscriptStore(backend);
  await store.loadLatest("tab-3", "/s/legacy.jsonl", { turns: 12 });

  // re-keyed legacy rows (no messageId): entryId differs → appended (old behaviour)
  const rewindRows = messages.map((m, i) => mkEntry(i, 1, m));
  const appended = store.appendEntries("tab-3", "/s/legacy.jsonl", rewindRows);
  eq(appended.length, 2, "legacy rows without messageId are NOT message-deduped (entryId guard only)");
}

// 4. a row re-keyed across a full reload (loadLatest) does not duplicate
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  // First load under revision 0; a later loadLatest under revision 1 (rewind)
  // re-keyed the same messages — replaceRecords rebuilds from scratch, so no
  // cross-generation duplicate can survive within one projection.
  const b0 = new FakeBackend(messages, 0);
  const store = new TranscriptStore(b0);
  const first = await store.loadLatest("tab-4", "/s/reload.jsonl", { turns: 12 });
  eq(first?.items.length, 2, "first load has 2 items");

  const b1 = new FakeBackend(messages, 1);
  const store1 = new TranscriptStore(b1);
  const second = await store1.loadLatest("tab-4", "/s/reload.jsonl", { turns: 12 });
  eq(second?.items.length, 2, "rewound reload still projects 2 items");
  ok(uniqueIds(second?.items ?? []), "rewound reload has unique ids");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
