import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Where a mid-turn interjection goes. */
export type GuidanceTarget = "steer" | "followup";

/**
 * Session-scoped interjection target. Each draft key remembers its own choice,
 * so switching sessions never carries the mode across and a fresh session
 * starts on the default (`steer`).
 *
 * Kept out of localStorage on purpose: this is a per-conversation intent, not a
 * preference — a user who queued once should not silently keep queueing in every
 * later session.
 */
export function useGuidanceTarget(draftKey: string): [GuidanceTarget, (next: GuidanceTarget) => void] {
  const byDraft = useRef<Record<string, GuidanceTarget>>({});
  const [target, setTarget] = useState<GuidanceTarget>(() => byDraft.current[draftKey] ?? "steer");

  useLayoutEffect(() => {
    setTarget(byDraft.current[draftKey] ?? "steer");
  }, [draftKey]);

  const choose = useCallback((next: GuidanceTarget) => {
    byDraft.current[draftKey] = next;
    setTarget(next);
  }, [draftKey]);

  return [target, choose];
}
