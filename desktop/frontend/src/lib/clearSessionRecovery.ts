// Recovery for a clear-context request the host refused.
//
// A refused clear is not "nothing happened": the controller may already have
// rotated (its transition callback republishes the tab's path) and only a
// follow-up step failed. Re-read the authoritative session identity instead of
// assuming the old transcript is still live, then rethrow so the clear-context
// surface warns the user rather than reporting success for a clear that never
// completed.
//
// Kept out of useController.ts on purpose: that hook sits at its size budget,
// and this step has no dependency on the rest of its closure beyond the two
// callbacks passed in.

type RefreshMeta = (tabId: string) => Promise<void>;

type ReloadTranscript = (
  tabId: string,
  reset: boolean,
  reason: "startup",
  options: { preserveCachedHistory: boolean },
) => Promise<unknown>;

export async function recoverRefusedClear(
  tabId: string | undefined,
  refreshMeta: RefreshMeta,
  reloadTranscript: ReloadTranscript,
  err: unknown,
): Promise<never> {
  if (tabId) {
    await refreshMeta(tabId).catch(() => {});
    await reloadTranscript(tabId, false, "startup", { preserveCachedHistory: true }).catch(() => {});
  }
  throw err;
}
