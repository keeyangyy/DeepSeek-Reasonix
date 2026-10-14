// Run: tsx src/__tests__/transcript-turnid-align.test.ts
//
// A2-a: the history page carries the in-flight turn's id, and live rows of
// that turn (their a:<turnId>: prefix) are matched exactly — no content guessing.

import { TranscriptStore } from "../lib/transcriptStore";
import { liveItemTurnId } from "../lib/hydrateHistoryApply";
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

console.log("\ntranscript turnId align");

// 1. liveItemTurnId extracts the turn id from a:<turnId>:<seq>
{
  eq(liveItemTurnId("a:turn-1:0"), "turn-1", "extracts turn id from live row");
  eq(liveItemTurnId("a:01M2ZZG7:3"), "01M2ZZG7", "extracts ULID turn id");
  eq(liveItemTurnId("he:s1:r0:m0:o0"), undefined, "history row has no live turn id");
  eq(liveItemTurnId("u1"), undefined, "frontend-local user row has no live turn id");
  eq(liveItemTurnId("a:"), undefined, "malformed live id yields undefined");
}

// 2. the projection surfaces the page's open turn id
{
  const messages: HistoryMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  class Backend {
    async HistorySliceForTab(_t: string, _r: HistorySliceRequest): Promise<HistorySlice> {
      const entries: HistoryEntry[] = messages.map((m, i) => ({
        entryId: `s1:r0:m${i}:o0`,
        messageId: `mid-${i}`,
        turn: 1,
        order: i,
        message: m,
        refs: [] as HistoryContentRef[],
      }));
      return { entries, nextCursor: "", hasOlder: false, totalTurns: 1, startTurn: 1, endTurn: 1, stale: false, revision: 1, revisionKnown: true, digest: "d", openTurnId: "turn-A" };
    }
    async HistoryContentForTab(_t: string, ref: HistoryContentRef, c: number): Promise<HistoryContentChunk> {
      return { entryId: ref.entryId, field: ref.field, chunk: c, chunks: 1, data: "", done: true, stale: false };
    }
  }
  const store = new TranscriptStore(new Backend());
  const projection = await store.loadLatest("tab-1", "/s/turn.jsonl", { turns: 12 });
  eq(projection?.openTurnId, "turn-A", "projection surfaces the open turn id");
  eq(projection?.items.length, 2, "two rows projected");
}

// 3. legacy history (no open turn) leaves the projection open turn id empty
{
  const messages: HistoryMessage[] = [{ role: "user", content: "q1" }];
  class Backend {
    async HistorySliceForTab(_t: string, _r: HistorySliceRequest): Promise<HistorySlice> {
      const entries: HistoryEntry[] = messages.map((m, i) => ({
        entryId: `s1:r0:m${i}:o0`,
        turn: 1,
        order: i,
        message: m,
        refs: [] as HistoryContentRef[],
      }));
      return { entries, nextCursor: "", hasOlder: false, totalTurns: 1, startTurn: 1, endTurn: 1, stale: false, revision: 1, revisionKnown: true, digest: "d" };
    }
    async HistoryContentForTab(_t: string, ref: HistoryContentRef, c: number): Promise<HistoryContentChunk> {
      return { entryId: ref.entryId, field: ref.field, chunk: c, chunks: 1, data: "", done: true, stale: false };
    }
  }
  const store = new TranscriptStore(new Backend());
  const projection = await store.loadLatest("tab-2", "/s/legacy.jsonl", { turns: 12 });
  eq(projection?.openTurnId, undefined, "legacy page has no open turn id");
}

// 4. exact alignment: a live row of the page's open turn is superseded
{
  const liveRows = [
    { id: "a:turn-A:0" },
    { id: "a:turn-A:1" },
    { id: "u1" },
  ];
  const openTurnId = "turn-A";
  const superseded = liveRows.filter((row) => liveItemTurnId(row.id) === openTurnId).map((row) => row.id);
  eq(superseded.length, 2, "both live rows of the open turn are identified");
  eq(superseded[0], "a:turn-A:0", "first live row superseded");
  eq(superseded[1], "a:turn-A:1", "second live row superseded");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
