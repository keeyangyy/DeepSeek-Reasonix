// Unit tests for the pure helpers of the session-dup diagnostics probe
// (test/live-dup line). The record/subscription surfaces are inert in a
// plain node environment; only the formatting and duplicate-pair scanning
// logic is exercised here.

import assert from "node:assert/strict";
import { describeRow, describeRows, findDuplicatePairs } from "../lib/sessionDupProbe";

// ── describeRow ─────────────────────────────────────────────────────────────

assert.equal(
  describeRow({ kind: "assistant", id: "he:a1", text: "hello" }),
  "assistant|he:a1|hello",
);
assert.equal(
  describeRow({ kind: "assistant", id: "a:7", text: "hi", streaming: true }),
  "assistant|a:7|hi [S]",
);
assert.equal(
  describeRow({ kind: "tool", id: "tc9", text: "tool body", status: "running" }),
  "tool|tc9|tc9 [st:running]",
);
const longText = "x".repeat(40);
assert.equal(describeRow({ kind: "assistant", id: "a:1", text: longText }), "assistant|a:1|" + "x".repeat(24) + "…");
assert.equal(describeRow({}), "?|?|");

// ── describeRows ────────────────────────────────────────────────────────────

assert.equal(describeRows([]), "(none)");
assert.equal(describeRows([{ kind: "user", id: "u1", text: "p" }]), "user|u1|p");
{
  const rows = Array.from({ length: 100 }, (_, i) => ({ kind: "user", id: `u${i}`, text: `t${i}` }));
  const out = describeRows(rows, 20);
  const lines = out.split("\n");
  assert.equal(lines.length, 21, "head 10 + ellipsis + tail 10");
  assert.equal(lines[0], "user|u0|t0");
  assert.equal(lines[10], "… 80 more …");
  assert.equal(lines[20], "user|u99|t99");
}

// ── findDuplicatePairs ─────────────────────────────────────────────────────

// Same backend entry on both sides (page rows are he:<entry>, live rows may
// be he: ids from a previous prepend or local allocator ids).
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "assistant", id: "he:r1", text: "full thinking" }],
    [{ kind: "assistant", id: "he:r1", text: "full thinking" }],
  ),
  [{ a: "he:r1", b: "he:r1", kind: "assistant", by: "entry" }],
);

// A tool call row duplicated across a split (he:<entry>:tc1 vs raw toolCallId
// cannot match by entry; the raw id match is the tool case).
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "tool", id: "tc42" }],
    [{ kind: "tool", id: "tc42" }],
  ),
  [{ a: "tc42", b: "tc42", kind: "tool", by: "id" }],
);

// Entry match across id styles: page he:<entry>:tcN normalizes to <entry>.
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "tool", id: "he:r7:tc2" }],
    [{ kind: "tool", id: "he:r7:tc9" }],
  ),
  [{ a: "he:r7:tc2", b: "he:r7:tc9", kind: "tool", by: "entry" }],
);

// Assistant rows with identical text (the "thinking duplicated" symptom) even
// when ids differ (live allocator id vs page he: entry).
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "assistant", id: "he:r2", text: "  same reasoning  " }],
    [{ kind: "assistant", id: "a:3", text: "same reasoning" }],
  ),
  [{ a: "he:r2", b: "a:3", kind: "assistant", by: "text" }],
);

// Different kinds and different texts never pair.
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "assistant", id: "he:r1", text: "one" }, { kind: "user", id: "he:u1", text: "prompt" }],
    [{ kind: "assistant", id: "a:1", text: "two" }, { kind: "user", id: "u:1", text: "different" }],
  ),
  [],
);

// Kinds that do not carry a text body (tool) must not pair on empty text.
assert.deepEqual(
  findDuplicatePairs(
    [{ kind: "tool", id: "he:r1:tc1", text: "same" }],
    [{ kind: "tool", id: "he:r2:tc1", text: "same" }],
  ).filter((pair) => pair.by === "text"),
  [],
);

// Cap: only the first `cap` pairs are reported.
{
  const page = Array.from({ length: 20 }, (_, i) => ({ kind: "assistant", id: `he:r${i}`, text: `same ${i}` }));
  const live = Array.from({ length: 20 }, (_, i) => ({ kind: "assistant", id: `a:${i}`, text: `same ${i}` }));
  assert.equal(findDuplicatePairs(page, live).length, 8);
  assert.equal(findDuplicatePairs(page, live, 3).length, 3);
}

console.log("session-dup-probe: all assertions passed");
