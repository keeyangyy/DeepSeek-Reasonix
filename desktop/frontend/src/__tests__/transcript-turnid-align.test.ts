// Run: tsx src/__tests__/transcript-turnid-align.test.ts
//
// A2-a: history rows carry the producing turn's id, and live rows can be
// matched to them by turn id (their a:<turnId>: prefix) instead of by content.

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

// 2. store stamps the producing turn onto projected items
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
        turnId: i === 0 ? "turn-A" : "turn-A", // both rows from the same turn
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
  const projection = await store.loadLatest("tab-1", "/s/turn.jsonl", { turns: 12 });
  const items = projection?.items ?? [];
  eq(items.length, 2, "two rows projected");
  eq(items[0]?.turnId, "turn-A", "user row stamped with its turn id");
  eq(items[1]?.turnId, "turn-A", "assistant row stamped with its turn id");
}

// 3. legacy history (no turnId) leaves items unstamped
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
  eq((projection?.items ?? [])[0]?.turnId, undefined, "legacy row is not stamped with a turn id");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
