import type { State } from "./useController";

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
export function replayTurnRebuild(s: State, turnId?: string): State {
  const prefix = turnId ? `a:${turnId}:` : undefined;
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
