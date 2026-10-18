import { useCallback, useEffect, useState } from "react";

// Archiving a conversation is recoverable, so it takes one click. A permanent
// delete takes two, and the armed half only means "the click a moment ago was the
// first half of this delete". Pointing anywhere outside the row or menu that owns
// it, letting it sit, or arming another target drops it — otherwise a stray early
// click would leave a later single click able to delete for good.
export const REMOVAL_ARM_MS = 4000;

// The surfaces a pending delete belongs to. These must match the real DOM classes,
// or a press on the armed button itself would release the arm before its click lands.
const REMOVAL_ARM_KEEP = ".project-tree__topic-actions, .context-menu, .history-selection, .history-preview__actions";

export type RemovalArm = {
  /** True when this exact target is awaiting its confirming click. */
  isArmed: (key: string) => boolean;
  /** Release any pending delete, e.g. when its menu or surface closes. */
  disarm: () => void;
  /** Arm `key`, or run `run` when `key` is already armed. */
  confirm: (key: string, run: () => void) => void;
};

export function useRemovalArm(keepSelector: string = REMOVAL_ARM_KEEP): RemovalArm {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  // Setting the same value twice is a no-op for React, so releasing needs no guard.
  const disarm = useCallback(() => setArmedKey(null), []);
  const isArmed = useCallback((key: string) => armedKey === key, [armedKey]);
  const confirm = useCallback((key: string, run: () => void) => {
    if (armedKey !== key) {
      setArmedKey(key);
      return;
    }
    setArmedKey(null);
    run();
  }, [armedKey]);

  useEffect(() => {
    if (armedKey === null) return undefined;
    // Capture phase: the owning row and menu keep their own presses, everything
    // else releases the arm before the click that follows could confirm a delete
    // the user stopped meaning. The same release also runs on a timeout, so an
    // untouched arm cannot wait indefinitely for a second click.
    const release = (event: PointerEvent) => {
      const node = event.target instanceof Element ? event.target : null;
      if (!node?.closest(keepSelector)) disarm();
    };
    window.addEventListener("pointerdown", release, true);
    const timer = setTimeout(disarm, REMOVAL_ARM_MS);
    return () => {
      window.removeEventListener("pointerdown", release, true);
      clearTimeout(timer);
    };
  }, [armedKey, disarm, keepSelector]);

  return { isArmed, disarm, confirm };
}
