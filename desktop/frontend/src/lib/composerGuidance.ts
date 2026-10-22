export function guidanceNeedsRetry(state?: string): boolean {
  return state === "uncertain" || state === "blocked";
}

export function guidanceIsInFlight(state?: string): boolean {
	return state === "steer_accepted";
}

export function guidanceHasKnownPendingState(state?: string): boolean {
	return state === undefined || state === "" || state === "queued" || state === "blocked" || state === "uncertain" || state === "steer_accepted";
}

// An accepted steer's body is still on disk until the agent consumes it, so the
// edit is what the consumer reads. Once consumed the same edit fails closed with
// invalid-state and the row is no longer editable, which keeps the two queue
// states behaving alike from the user's point of view.
export function guidanceIsEditable(item: { id?: string; state?: string; source?: string; paused?: boolean }): boolean {
  if (!item.id || item.id.startsWith("local-")) return false;
  if (item.paused || guidanceNeedsRetry(item.state)) return false;
  return item.state === "queued" || item.state === "steer_accepted" || item.state === undefined || item.state === "";
}

export function markGuidanceQueued<T extends { id: string; state?: string; paused?: boolean }>(items: T[], id: string): T[] {
  return items.map((item) => item.id === id ? { ...item, state: "queued", paused: false } : item);
}

// Moving between groups is a fresh arrival, so the row re-queues at the end of
// the target group instead of inheriting the position it held in the other one.
// Both directions go through here to keep that rule identical.
function requeueAtEnd<T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] {
  const target = items.find((item) => item.id === id);
  if (!target) return items;
  return [...items.filter((item) => item.id !== id), { ...target, ...patch }];
}

// An accepted steer joins the running turn, which places it last among the
// guidance already admitted to this turn.
export function markGuidanceSteered<T extends { id: string; state?: string; intent?: string }>(items: T[], id: string): T[] {
  return requeueAtEnd(items, id, { state: "steer_accepted", intent: "steer" } as Partial<T>);
}

// Releasing puts the row back at the tail of the next-turn queue, as if it had
// just been written: it must not resume a slot it already left.
export function markGuidanceReleased<T extends { id: string; state?: string; intent?: string }>(items: T[], id: string): T[] {
  return requeueAtEnd(items, id, { state: "queued", intent: "followup" } as Partial<T>);
}

// Resuming an already-unpaused inbox is an idempotent Controller drain kick.
export async function kickIdleGuidance(
  setPaused: (tabId: string, paused: boolean) => Promise<void>,
  tabId: string,
  refresh: () => void,
): Promise<void> {
  await setPaused(tabId, false);
  refresh();
}

// Exact equality avoids consuming a different queued item whose text merely
// contains the accepted steer (#6238).
export function guidanceTextMatches(queued: string, consumed: string): boolean {
  const left = queued.trim();
  const right = consumed.trim();
  return Boolean(left && right && left === right);
}
