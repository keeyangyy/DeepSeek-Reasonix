import type { AppBindings } from "./bridge";
import { isInboxItemMissing } from "./inboxError";
import { markGuidanceReleased } from "./composerGuidance";
import type { PendingGuidance } from "../components/ComposerGuidanceShelf";

// Queue mutations live outside Composer so the component keeps one call per row
// action. Every handler shares the same shape: guard a local-only row, resolve
// the draft it belongs to, call the host, then mirror the change locally.
type InboxQueueBindings = Pick<
  AppBindings,
  "UpdateInboxItem" | "ReadInboxItem" | "DeleteInboxItem" | "MoveInboxItem" | "ReleaseInboxItem"
>;

export type InboxQueueDeps = {
  app: InboxQueueBindings;
  tabId: string;
  draftKey: () => string;
  updateItems: (draftKey: string, update: (items: PendingGuidance[]) => PendingGuidance[]) => void;
  warn: (error: unknown) => void;
  readText: () => string;
  writeText: (text: string) => void;
  focus: () => void;
  requestFrame: (callback: () => void) => void;
};

export function makeInboxQueueActions(deps: InboxQueueDeps) {
  const { app, tabId, draftKey, updateItems, warn, readText, writeText, focus, requestFrame } = deps;
  const local = (item: PendingGuidance) => item.id.startsWith("local-");

  const editQueuedGuidance = async (item: PendingGuidance, nextText: string) => {
    const text = nextText.trim();
    if (!text || local(item)) return;
    try {
      await app.UpdateInboxItem(tabId, item.id, text, text);
      updateItems(draftKey(), (items) =>
        items.map((queued) => queued.id === item.id ? { ...queued, text, submitText: text } : queued),
      );
    } catch (error) {
      warn(error);
      throw error;
    }
  };

  // Recall reads before deleting: a row the agent already consumed fails at the
  // read, so the text is never dropped from a queue the user cannot see.
  const recallQueuedGuidance = async (item: PendingGuidance) => {
    if (local(item)) return;
    try {
      const stored = await app.ReadInboxItem(tabId, item.id);
      const recalled = (stored?.submitText || stored?.rawText || item.submitText || item.text).trim();
      if (!recalled) return;
      await app.DeleteInboxItem(tabId, item.id);
      updateItems(draftKey(), (items) => items.filter((queued) => queued.id !== item.id));
      const current = readText().trim();
      writeText(current ? `${current}\n${recalled}` : recalled);
      requestFrame(focus);
    } catch (error) {
      if (isInboxItemMissing(error)) {
        updateItems(draftKey(), (items) => items.filter((queued) => queued.id !== item.id));
        return;
      }
      warn(error);
    }
  };

  // The store clamps the target and refuses a delivered steer, so a stale drag
  // cannot corrupt the queue.
  const moveQueuedGuidance = async (item: PendingGuidance, toIndex: number) => {
    if (local(item)) return;
    try {
      await app.MoveInboxItem(tabId, item.id, toIndex);
      updateItems(draftKey(), (items) => {
        const from = items.findIndex((queued) => queued.id === item.id);
        if (from < 0 || from === toIndex) return items;
        const next = [...items];
        const [moved] = next.splice(from, 1);
        next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
        return next;
      });
    } catch (error) {
      warn(error);
    }
  };

  // Release hands an accepted steer back to the queue. The store refuses once
  // the agent consumed it, so the row keeps its text and the error is visible.
  // It re-queues at the tail, as if it had just been written.
  const releaseQueuedGuidance = async (item: PendingGuidance) => {
    if (local(item)) return;
    try {
      await app.ReleaseInboxItem(tabId, item.id);
      updateItems(draftKey(), (items) => markGuidanceReleased(items, item.id));
    } catch (error) {
      warn(error);
    }
  };

  return { editQueuedGuidance, recallQueuedGuidance, moveQueuedGuidance, releaseQueuedGuidance };
}

export type QueueActions = ReturnType<typeof makeInboxQueueActions>;
