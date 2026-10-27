import { Fragment, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, CornerDownRight, GripVertical, Pencil, Trash2, Undo2, X } from "lucide-react";
import { app } from "../lib/bridge";
import { guidanceHasKnownPendingState, guidanceIsEditable, guidanceIsInFlight, guidanceNeedsRetry } from "../lib/composerGuidance";
import { clearGuidanceDraft, readGuidanceDraft, writeGuidanceDraft } from "../lib/guidanceDraft";
import { useI18n } from "../lib/i18n";
import type { StructuredInvocationSubmit } from "../lib/invocationDisplay";
import { InboxRecoveryBanner } from "./InboxRecoveryBanner";
import { Tooltip } from "./Tooltip";

export type PendingGuidance = {
  id: string;
  text: string;
  submitText: string;
  /** Item version from the host snapshot; echoed back on edit/move. */
  revision?: number;
  state?: string;
  intent?: string;
  source?: string;
  paused?: boolean;
  recoveredCount?: number;
  structured?: StructuredInvocationSubmit;
};

export type InboxRecoveryNotice = {
  draftKey: string;
  tabId: string;
  count: number;
  recovered: boolean;
};

// The shelf header carries one control: whether the queue keeps dispatching or
// is held. It maps to the host's inbox `paused` flag (the same one the recovery
// banner drives), so "paused" here means "the next turn will not start on its
// own" — not "this row goes elsewhere". Kept out of the locale bundle because
// the zh chunk is at its gzip budget; the strings are two labels, not a system.
const DISPATCH_COPY = {
  en: ["Pause dispatch", "Resume dispatch"],
  zh: ["暂停派发", "继续派发"],
  "zh-TW": ["暫停派發", "繼續派發"],
} as const;

export function ComposerGuidanceShelf({
  draftKey,
  tabId,
  recovery,
  recoveryDisabled,
  items,
  expanded,
  running,
  disabled,
  readOnly,
  sendingId,
  onReview,
  onRecoveryResumed,
  onRecoveryError,
  onToggleExpanded,
  onSend,
  onDismiss,
  onEdit,
  onRecall,
  onMove,
  onRelease,
}: {
  draftKey: string;
  tabId: string;
  recovery: InboxRecoveryNotice | null;
  recoveryDisabled: boolean;
  items: PendingGuidance[];
  expanded: boolean;
  running: boolean;
  disabled: boolean;
  readOnly: boolean;
  sendingId: string | null;
  onReview: () => void;
  onRecoveryResumed: () => void;
  onRecoveryError: (error: unknown) => void;
  onToggleExpanded: () => void;
  onSend: (item: PendingGuidance) => void;
  onDismiss: (item: PendingGuidance) => void;
  onEdit?: (item: PendingGuidance, text: string) => void | Promise<void>;
  onRecall?: (item: PendingGuidance) => void | Promise<void>;
  onMove?: (item: PendingGuidance, toIndex: number) => void | Promise<void>;
  onRelease?: (item: PendingGuidance) => void | Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [pauseLabel, resumeLabel] = DISPATCH_COPY[locale] ?? DISPATCH_COPY.en;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const dragFromRef = useRef<number | null>(null);
  // Paused is host state carried by the snapshot; the shelf only mirrors it.
  const paused = Boolean(items[0]?.paused);

  // Flipping the host flag refreshes through the inbox change event, so the
  // header label and row gates update without an extra reload here.
  const togglePaused = async () => {
    if (pauseBusy) return;
    setPauseBusy(true);
    try {
      await app.SetInboxPaused(tabId, !paused);
    } catch (error) {
      onRecoveryError(error);
    } finally {
      setPauseBusy(false);
    }
  };

  // A steer-intent row is guidance for the turn that is already running; a
  // followup row waits for the next turn. The two are rendered as separate
  // groups so the queue reads as "now" and "next", even though the store keeps
  // them in one list.
  const isCurrentTurn = (item: PendingGuidance) => item.intent === "steer" || guidanceIsInFlight(item.state);
  // Order first, then truncate. The store keeps one list and an accepted steer
  // moves to its tail, so slicing before sorting hid the very row the user is
  // waiting on and showed only the follow-ups queued ahead of it.
  const orderedAll = [...items].sort((a, b) => Number(isCurrentTurn(b)) - Number(isCurrentTurn(a)));
  const ordered = expanded ? orderedAll : orderedAll.slice(0, 2);
  const hiddenCount = Math.max(0, items.length - 2);

  const startEdit = (item: PendingGuidance) => {
    setEditingId(item.id);
    // A stored draft wins over the saved body: it is text the user typed but
    // never submitted, so restoring it is the whole point of the draft.
    setEditDraft(readGuidanceDraft(draftKey, item.id) || item.submitText.trim() || item.text);
  };

  const cancelEdit = () => {
    // Cancelling is an explicit discard, so the draft goes with it.
    if (editingId) clearGuidanceDraft(draftKey, editingId);
    setEditingId(null);
    setEditDraft("");
    setEditBusy(false);
  };

  const saveEdit = async (item: PendingGuidance) => {
    if (!onEdit || editBusy) return;
    const next = editDraft.trim();
    if (!next) return;
    setEditBusy(true);
    try {
      await onEdit(item, next);
      clearGuidanceDraft(draftKey, item.id);
      setEditingId(null);
      setEditDraft("");
      setEditBusy(false);
    } catch {
      setEditBusy(false);
    }
  };

  const recallItem = async (item: PendingGuidance) => {
    if (!onRecall) return;
    await onRecall(item);
  };

  return (
    <>
      {recovery && (
        <InboxRecoveryBanner
          key={`${recovery.draftKey}:${recovery.tabId}`}
          count={recovery.count}
          recovered={recovery.recovered}
          disabled={recoveryDisabled}
          tabId={recovery.tabId}
          onReview={onReview}
          onResumed={onRecoveryResumed}
          onError={onRecoveryError}
        />
      )}
      {items.length > 0 && (
        <div className="composer-guidance-shelf" aria-label={t("composer.guidanceQueue")}>
          <div className="composer-guidance-head">
            <span className="composer-guidance-head__label">
              <CornerDownRight size={14} />
              <span>{t("composer.guidanceCount", { n: items.length })}</span>
            </span>
            <button
              className={`composer-guidance-head__dispatch${paused ? " composer-guidance-head__dispatch--paused" : ""}`}
              type="button"
              aria-pressed={paused}
              disabled={disabled || readOnly || pauseBusy}
              onClick={() => void togglePaused()}
            >
              {paused ? resumeLabel : pauseLabel}
            </button>
          </div>
          <div
            className="composer-guidance-list"
            onDragOver={(event) => {
              if (dragFromRef.current === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragFromRef.current;
              dragFromRef.current = null;
              if (from === null) return;
              const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
              const to = Number(row?.dataset.row);
              if (!row || !Number.isInteger(to) || to === from) return;
              // The shelf renders "this turn" rows first, so a visual index is not
              // a queue index. Map the drop target back to the store's own order.
              const target = items.indexOf(ordered[to]);
              if (target >= 0) void onMove?.(ordered[from], target);
            }}
          >
            {ordered.map((item, index) => {
              const unknownState = !guidanceHasKnownPendingState(item.state);
              const needsRetry = guidanceNeedsRetry(item.state);
              const currentTurn = isCurrentTurn(item);
              const groupIndex = ordered.slice(0, index).filter((other) => isCurrentTurn(other) === currentTurn).length;
              const startsGroup = groupIndex === 0;
              // Every row action shares one gate: an interactive, writable shelf
              // that is not already sending another row.
              const idle = !readOnly && !disabled && sendingId === null;
              const canEdit = idle && Boolean(onEdit) && guidanceIsEditable(item);
              const canRecall = idle && Boolean(onRecall) && !item.id.startsWith("local-") && !item.paused;
              // Only the next-turn group reorders: an accepted steer is already
              // delivered, so moving it would promise an order the agent ignores.
              const canMove = idle && Boolean(onMove) && !currentTurn && !item.paused;
              // Releasing hands an accepted steer back to the queue.
              const canRelease = idle && Boolean(onRelease) && !item.paused;
              const editing = editingId === item.id;
              const guideModeKey = needsRetry
                ? "composer.guidanceRetryMode"
                : currentTurn
                  ? "composer.guidanceToNextMode"
                  : "composer.guidanceToNowMode";
              const actionLabel = t(needsRetry
                ? "composer.guidanceRetry"
                : currentTurn
                  ? "composer.guidanceToNext"
                  : "composer.guidanceToNow");
              return (
                <Fragment key={item.id}>
                  {startsGroup && (
                    <div className="composer-guidance-group" role="presentation">
                      {t(currentTurn ? "composer.guidanceGroupNow" : "composer.guidanceGroupNext")}
                    </div>
                  )}
                  <div
                    className={`composer-guidance-item${editing ? " composer-guidance-item--editing" : ""}`}
                    data-row={index}
                  >
                    {canMove ? (
                      <span
                        className="composer-guidance-item__grip"
                        role="button"
                        tabIndex={0}
                        aria-label={t("composer.guidanceReorder")}
                        draggable
                        onDragStart={(event) => {
                          dragFromRef.current = index;
                          event.dataTransfer.effectAllowed = "move";
                          // Without a payload the platform cancels the drag, so the
                          // grip would look draggable and never start.
                          event.dataTransfer.setData("text/plain", item.id);
                        }}
                        onDragEnd={() => {
                          dragFromRef.current = null;
                        }}
                      >
                        <GripVertical size={14} />
                      </span>
                    ) : (
                      <CornerDownRight size={14} className="composer-guidance-item__icon" />
                    )}
                  {editing ? (
                    <input
                      className="composer-guidance-item__editor"
                      value={editDraft}
                      onChange={(event) => {
                        setEditDraft(event.target.value);
                        // Persist on every keystroke: the point is to survive a
                        // remount, and a debounce would lose the last words.
                        writeGuidanceDraft(draftKey, item.id, event.target.value);
                      }}
                      aria-label={t("composer.guidanceEdit")}
                      disabled={editBusy}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveEdit(item);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                    />
                  ) : (
                    <span className="composer-guidance-item__text">{item.text.trim() || t("composer.guidanceEmptyPreview")}</span>
                  )}
                  {editing ? (
                    <>
                      <Tooltip label={t("composer.guidanceSaveEdit")}>
                        <button
                          className="composer-guidance-item__action"
                          type="button"
                          aria-label={t("composer.guidanceSaveEdit")}
                          disabled={editBusy || !editDraft.trim()}
                          onClick={() => void saveEdit(item)}
                        >
                          <Check size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t("composer.guidanceCancelEdit")}>
                        <button
                          className="composer-guidance-item__action"
                          type="button"
                          aria-label={t("composer.guidanceCancelEdit")}
                          disabled={editBusy}
                          onClick={cancelEdit}
                        >
                          <X size={14} />
                        </button>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      {canEdit && (
                        <Tooltip label={t("composer.guidanceEdit")}>
                          <button
                            className="composer-guidance-item__action"
                            type="button"
                            aria-label={t("composer.guidanceEdit")}
                            onClick={() => startEdit(item)}
                          >
                            <Pencil size={14} />
                          </button>
                        </Tooltip>
                      )}
                      {canRecall && (
                        <Tooltip label={t("composer.guidanceRecall")}>
                          <button
                            className="composer-guidance-item__action"
                            type="button"
                            aria-label={t("composer.guidanceRecall")}
                            disabled={sendingId !== null}
                            onClick={() => void recallItem(item)}
                          >
                            <Undo2 size={14} />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip label={actionLabel}>
                        <button
                          className="composer-guidance-item__guide"
                          type="button"
                          aria-label={actionLabel}
                          disabled={unknownState || disabled || readOnly || sendingId !== null || (running && !needsRetry && Boolean(item.structured)) || Boolean(item.paused) || (currentTurn && !canRelease)}
                          onClick={() => {
                            // Retry keeps its own path; only a healthy row switches
                            // between promoting and releasing.
                            if (needsRetry) {
                              onSend(item);
                              return;
                            }
                            // One control, two directions: a next-turn row is
                            // promoted into the running turn, an accepted steer is
                            // handed back to the queue.
                            if (currentTurn) {
                              void onRelease?.(item);
                              return;
                            }
                            onSend(item);
                          }}
                        >
                          <CornerDownRight size={13} />
                          <span>{t(guideModeKey)}</span>
                        </button>
                      </Tooltip>
                      <Tooltip label={t("composer.guidanceDismiss")}>
                        <button
                          className="composer-guidance-item__action"
                          type="button"
                          aria-label={t("composer.guidanceDismiss")}
                          // Removal stays available for an accepted steer: the
                          // backend deletes it through DeletePendingOrAcceptedItem,
                          // so gating on inFlight only hid a working action.
                          disabled={disabled || readOnly || unknownState || sendingId === item.id}
                          onClick={() => onDismiss(item)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
                    </>
                  )}
                  </div>
                </Fragment>
              );
            })}
            {items.length > 2 && (
              <button
                className="composer-guidance-more"
                type="button"
                aria-expanded={expanded}
                onClick={onToggleExpanded}
              >
                {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <span>{expanded ? t("composer.guidanceCollapse") : t("composer.guidanceRemaining", { n: hiddenCount })}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
