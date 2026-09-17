import type { Item, State } from "./useController";

// HistoryPage row ids carry the page-local prefix `h<startTurn>-` (see
// historyPageItems); optimistic/live rows never do. Rebuild only drops these
// page-residue rows past the turn anchor, so legacy `h<seq>` rows and the
// resident page prefix accounting stay intact.
const HISTORY_PAGE_ROW_ID = /^h\d+-/;

/**
 * Drop everything the transcript has already mounted for the turn that is
 * about to be replayed from its first event:
 * - live/replayed rows `a:<turnId>:<ordinal>` (their deltas would otherwise be
 *   appended onto the existing live buffer and double the visible text), and
 * - settled page residue after the last user anchor (page rows for the turn's
 *   already-persisted segments would otherwise co-mount next to the replayed
 *   rebuild of the same content).
 *
 * The user anchor itself (page row or optimistic row) survives so the rebuilt
 * rows reattach under it. When no anchor exists the drop degrades to the
 * turnId-prefix rows only — nothing is lost, the replayed surface simply has
 * no user heading (the same prelude shape the backend cannot rebuild).
 */
export function replayTurnRebuild(s: State, turnId?: string): State {  const prefix = turnId ? `a:${turnId}:` : undefined;
  let anchorIndex = -1;
  for (let i = s.items.length - 1; i >= 0; i -= 1) {
    if (s.items[i].kind === "user") { anchorIndex = i; break; }
  }
  let droppedPrefixRows = 0;
  const nextItems = s.items.filter((item, index) => {
    if (prefix && item.id.startsWith(prefix)) return false;
    if (anchorIndex >= 0 && index > anchorIndex) {
      if (HISTORY_PAGE_ROW_ID.test(item.id)) droppedPrefixRows += 1;
      return false;
    }
    return true;
  });
  if (
    nextItems.length === s.items.length &&
    !s.currentAssistant &&
    !s.live &&
    s.assistantSegmentOrdinal === 0
  ) return s;
  return {
    ...s,
    items: nextItems,
    historyPrefixCount: Math.max(0, s.historyPrefixCount - droppedPrefixRows),
    currentAssistant: undefined,
    assistantSegmentOrdinal: 0,
    live: undefined,
  };
}

// ── Row-level forensics (v2 diagnostics) ─────────────────────────────────────
// The frontend diagnostic JSON carries no line-level transcript shape, which is
// why the first fix round could not be verified from a user report. These
// helpers reduce a mounted transcript to whitelist-safe numbers: row counts,
// anchor identity, and a duplicate-signature pair count.

function signatureHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function itemSignatureToken(item: Item): string | undefined {
  // Unsettled/empty assistant rows (streaming placeholders, replay residue)
  // share one empty signature by construction — they are not user-visible
  // duplicates. Only rows with content participate in the duplicate count.
  if (item.kind === "assistant" && !item.text.trim() && !item.reasoning.trim()) return undefined;
  // Repeated identical tool calls (same name+args) and recurring notices are
  // legitimate content, not co-mounted duplicates — they are keyed by their
  // unique row id and excluded from the count.
  if (item.kind === "tool" || item.kind === "notice") return undefined;
  const body = item.kind === "assistant" ? `${item.text}\u0000${item.reasoning}`
    : item.kind === "user" ? item.text
    : item.id;
  return `${item.kind}:${signatureHash(body)}`;
}

/** How many rows carry a signature that at least one other row also carries. */
export function transcriptDuplicateSignatureCount(items: ReadonlyArray<Item>): number {
  const counts = new Map<string, number>();
  for (const item of items) {
    const sig = itemSignatureToken(item);
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) if (count > 1) duplicates += count - 1;
  return duplicates;
}

export type ReplayRebuildSnapshot = {
  rows: number;
  liveRows: number;
  userRows: number;
  anchor: string;
  duplicates: number;
};

/** Snapshot of the transcript the rebuild is about to clear (pre-dispatch). */
export function replayRebuildSnapshot(s: State, turnId?: string): ReplayRebuildSnapshot {
  const prefix = turnId ? `a:${turnId}:` : undefined;
  let liveRows = 0;
  let userRows = 0;
  let anchor = "";
  for (const item of s.items) {
    if (prefix && item.id.startsWith(prefix)) liveRows += 1;
    if (item.kind === "user") { userRows += 1; anchor = item.id; }
  }
  return {
    rows: s.items.length,
    liveRows,
    userRows,
    anchor,
    duplicates: transcriptDuplicateSignatureCount(s.items),
  };
}

const DUMP_TEXT_LIMIT = 120;
const DUMP_SECONDARY_LIMIT = 48;

function clip(text: string | undefined, limit: number): string {
  const value = text ?? "";
  return value.length > limit ? `${value.slice(0, limit)}…(${value.length})` : value;
}

/**
 * Full row-level dump of the mounted transcript: every row's id (id-family
 * prefix included), kind, and bounded content — the ground truth of what the
 * render array actually holds. Serialized once per forensic event; payload is
 * bounded by the clip limits (a few hundred rows stay well under 100 KiB).
 */
export function transcriptDumpJson(items: ReadonlyArray<Item>): string {
  return JSON.stringify(items.map((item) => {
    const row: Record<string, unknown> = { i: item.id, k: item.kind };
    if (item.kind === "user") {
      row.x = clip(item.text, DUMP_TEXT_LIMIT);
      if (item.checkpointTurn !== undefined) row.ct = item.checkpointTurn;
      if (item.historyTurn !== undefined) row.ht = item.historyTurn;
      if (item.submissionId) row.sid = clip(item.submissionId, 48);
    } else if (item.kind === "assistant") {
      row.x = clip(item.text, DUMP_TEXT_LIMIT);
      row.r = clip(item.reasoning, DUMP_SECONDARY_LIMIT);
      if (item.streaming) row.s = 1;
    } else if (item.kind === "tool") {
      row.n = clip(item.name, 48);
      row.x = clip(item.output, DUMP_SECONDARY_LIMIT);
      row.st = item.status;
      if (item.error) row.e = 1;
    } else if (item.kind === "notice") {
      row.x = clip(item.text, DUMP_SECONDARY_LIMIT);
      row.l = item.level;
    } else if (item.kind === "phase") {
      row.x = clip(item.text, DUMP_SECONDARY_LIMIT);
    } else if (item.kind === "compaction") {
      row.x = clip(item.summary, DUMP_SECONDARY_LIMIT);
    }
    return row;
  }));
}
