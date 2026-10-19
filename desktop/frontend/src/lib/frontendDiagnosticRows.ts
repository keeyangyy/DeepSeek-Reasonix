/**
 * Transcript-level diagnostics: row descriptors, page snapshots and wire-kind
 * tracing for the local opt-in recorder.
 *
 * Lives outside useController.ts because that file sits exactly on its repolint
 * line budget (800 + 4520 baselined); every helper here would otherwise have to
 * displace production code. Everything stays inside the recorder's contract:
 * values are safeToken-safe (`[a-zA-Z0-9._:-]{1,64}`), so text and reasoning are
 * recorded as LENGTHS, never as content, and ids are truncated.
 *
 * Why the extra detail compared with plain row tails: a history page landing on
 * a live turn is reconciled by messageID (`rebaseLiveAssistantToPage`), so a
 * capture that omits messageID cannot show WHICH page row a live segment was
 * merged into — exactly the question a misplaced reasoning block raises.
 */

import { duplicateItemRows } from "./hydrateHistoryApply";
import type { SignatureItem } from "./hydrateHistoryApply";
import { recordFrontendDiagnostic } from "./frontendDiagnosticBridge";

/** Enough of an id to tell rows apart after truncation (see describeRow). */
const ID_CHARS = 24;
/** Trailing messageID characters: distinguishes sibling assistant segments. */
const MESSAGE_ID_CHARS = 6;
/** Sequence field cap: the recorder rejects tokens over 64 characters. */
const SEQUENCE_CHARS = 60;
/** Row slots available on one event (r0..r5 in the schema). */
const ROW_SLOTS = 6;
/** Hard ceiling for one row descriptor: the recorder drops longer fields. */
const MAX_ROW_CHARS = 64;

const TOKEN_UNSAFE = /[^a-zA-Z0-9._:-]/g;

function tokenOf(value: unknown): string {
  return typeof value === "string" ? value.replace(TOKEN_UNSAFE, "") : "";
}

function lengthOf(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * One row as `kind.id[.status][.m<messageIdTail>].<textLen>.<reasoningLen>`.
 *
 * Both lengths matter: tool-only rounds carry no text at all, so a descriptor
 * showing only text length reads as "empty" and hides the reasoning that the
 * row actually rendered. The messageID tail is what rebase matches on.
 */
export function describeRow(item: SignatureItem): string {
  const casted = item as { reasoning?: unknown; status?: unknown };
  const status = typeof casted.status === "string" && casted.status ? `.${tokenOf(casted.status)}` : "";
  const messageID = typeof item.messageID === "string" && item.messageID
    ? `.m${tokenOf(item.messageID).slice(-MESSAGE_ID_CHARS)}`
    : "";
  const id = tokenOf(item.id).slice(0, ID_CHARS);
  const head = `${item.kind.charAt(0)}.${id}`;
  const tail = `${messageID}.${lengthOf(item.text)}.${lengthOf(casted.reasoning)}`;
  // The recorder drops a field over 64 characters outright, so an over-long
  // status would silently cost the whole row. Status is the least informative
  // part here: identity and both lengths must always survive.
  const withStatus = `${head}${status}${tail}`;
  return withStatus.length <= MAX_ROW_CHARS ? withStatus : `${head}${tail}`;
}

/** Tail row descriptors for slots r0..r5. */
export function rowSlots(rows: readonly SignatureItem[]): Record<string, string> {
  const described = rows.slice(0, ROW_SLOTS).map(describeRow);
  return Object.fromEntries(described.map((value, index) => [`r${index}`, value]));
}

/** Kind initials in order: `uattnat…` — reveals ordering without any content. */
export function rowSequence(rows: readonly SignatureItem[]): string {
  return rows.map((item) => item.kind.charAt(0)).join("").slice(0, SEQUENCE_CHARS);
}

/** The reducer state surface these helpers read; avoids importing State. */
export type DiagnosticRows = {
  items: readonly SignatureItem[];
  currentAssistant?: string;
};

/**
 * Record a page-merge event: the incoming page rows, the resulting rows, and
 * the duplicates/removals the merge produced.
 *
 * `pageItems` is the page the action carried (empty for non-page actions). When
 * it is present the capture holds both sides of the merge, so a row that landed
 * in the wrong order is visible by comparing the two sequences.
 */
export function recordPageDiagnostic(
  actionType: string,
  next: DiagnosticRows,
  pageItems: readonly SignatureItem[] | undefined,
  removedRows: readonly SignatureItem[],
): void {
  recordFrontendDiagnostic("history", "items.tail", {
    reason: actionType,
    state: `cur:${tokenOf(next.currentAssistant ?? "-").slice(0, ID_CHARS)}`,
    total: next.items.length,
    ...rowSlots([...next.items].slice(-ROW_SLOTS).reverse()),
  });
  if (pageItems) {
    recordFrontendDiagnostic("history", "history.page-rows", {
      reason: actionType,
      total: pageItems.length,
      state: rowSequence(pageItems),
      ...rowSlots([...pageItems].slice(-ROW_SLOTS).reverse()),
    });
  }
  if (removedRows.length > 0) {
    recordFrontendDiagnostic("history", "items.removed", {
      reason: actionType,
      total: removedRows.length,
      ...rowSlots(removedRows),
    });
  }
  const duplicates = duplicateItemRows(next.items);
  if (duplicates.length > 0) {
    recordFrontendDiagnostic("history", "items.dupes", {
      reason: actionType,
      total: duplicates.length,
      ...rowSlots(duplicates),
    });
  }
}

/**
 * Record a wire event that shapes the live tail. Only the event kind and its
 * structural counters are kept: `stream_attempt` decides whether a new assistant
 * segment opens or the previous one is reused, and `steer` is the mid-turn
 * insertion whose reconciliation this recording exists to explain.
 */
export function recordWireDiagnostic(event: {
  kind: string;
  turnId?: string;
  text?: string;
  itemId?: string;
  streamAttempt?: { id?: string; action?: string; messageId?: string; messageID?: string };
}): void {
  if (event.kind !== "stream_attempt" && event.kind !== "steer" && event.kind !== "turn_started" && event.kind !== "turn_done") return;
  const attempt = event.streamAttempt;
  const textLength = lengthOf(event.text);
  recordFrontendDiagnostic("runtime", "wire", {
    action: event.kind,
    status: attempt?.action,
    reason: tokenOf(event.turnId ?? "").slice(0, ID_CHARS) || undefined,
    state: attempt
      ? `m${tokenOf(attempt.messageId ?? attempt.messageID ?? "").slice(-MESSAGE_ID_CHARS)}`
      : textLength > 0
        ? `len${textLength}${event.itemId ? ".id" : ""}`
        : undefined,
    sequence: textLength,
  });
}