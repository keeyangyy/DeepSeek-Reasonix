// Guidance edit drafts survive a session switch, a panel collapse, or a reload.
//
// The shelf keeps its edit box in component state, so anything that remounts it
// (switching sessions, reopening the composer) used to drop whatever the user
// had typed. Drafts live in local storage keyed by draft + item, so the text
// comes back when the same row is edited again.

const PREFIX = "reasonix.guidance-draft:";
// Bound the stored text: an edit box this long is a paste, not a draft, and a
// runaway entry would sit in storage forever.
const MAX_DRAFT_LENGTH = 32 * 1024;

function storageKey(draftKey: string, itemID: string): string {
  return `${PREFIX}${draftKey}:${itemID}`;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Access itself throws when storage is blocked by policy.
    return undefined;
  }
}

export function readGuidanceDraft(draftKey: string, itemID: string): string {
  if (!draftKey || !itemID) return "";
  try {
    return storage()?.getItem(storageKey(draftKey, itemID)) ?? "";
  } catch {
    return "";
  }
}

export function writeGuidanceDraft(draftKey: string, itemID: string, text: string): void {
  if (!draftKey || !itemID) return;
  const capped = text.length > MAX_DRAFT_LENGTH ? text.slice(0, MAX_DRAFT_LENGTH) : text;
  try {
    const key = storageKey(draftKey, itemID);
    if (capped.trim()) storage()?.setItem(key, capped);
    else storage()?.removeItem(key);
  } catch {
    // Quota or a read-only store: a lost draft must never break the edit flow.
  }
}

export function clearGuidanceDraft(draftKey: string, itemID: string): void {
  if (!draftKey || !itemID) return;
  try {
    storage()?.removeItem(storageKey(draftKey, itemID));
  } catch {
    // ignore
  }
}