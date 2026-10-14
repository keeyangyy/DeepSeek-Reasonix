// Unified transcript item id factory.
// Replaces the ad-hoc id strings scattered across useController.ts with a
// single allocator that guarantees stable, collision-free ids for every item
// kind the transcript can emit.

export type ItemKind = "user" | "assistant" | "phase" | "notice" | "compaction" | "tool" | "extension";

let userSeq = 0;
let assistantSeq = 0;
let phaseSeq = 0;
let noticeSeq = 0;
let compactionSeq = 0;
let toolSeq = 0;
let extensionSeq = 0;

function next(kind: ItemKind): string {
  switch (kind) {
    case "user": return `u${++userSeq}`;
    case "assistant": return `a${++assistantSeq}`;
    case "phase": return `ph${++phaseSeq}`;
    case "notice": return `n${++noticeSeq}`;
    case "compaction": return `c${++compactionSeq}`;
    case "tool": return `t${++toolSeq}`;
    case "extension": return `x${++extensionSeq}`;
  }
}

// Deterministic ids from durable backend data (history items, tool calls).
// These must stay stable across re-renders and re-conversions.
export function stableHistoryItemId(entryId: string, kind: ItemKind): string {
  if (kind === "tool") return `he:${entryId}`; // toolCallId or entryId fallback
  return `h:${entryId}`;
}

export function stableToolItemId(toolCallId: string | undefined, entryId: string, callIndex: number): string {
  return toolCallId ? `he:${toolCallId}` : `he:${entryId}:tc${callIndex}`;
}

// Ephemeral ids for live/projected items (assistant segments, phases, notices).
// These are session-local and only need to be unique within one projection.
export function ephemeralItemId(kind: ItemKind): string {
  return next(kind);
}

// Reset allocator state (test only).
export function resetItemIdAllocator(): void {
  userSeq = 0;
  assistantSeq = 0;
  phaseSeq = 0;
  noticeSeq = 0;
  compactionSeq = 0;
  toolSeq = 0;
  extensionSeq = 0;
}
