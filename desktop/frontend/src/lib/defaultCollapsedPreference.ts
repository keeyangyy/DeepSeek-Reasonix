// defaultCollapsedPreference is now a THIN BOOLEAN VIEW over the three-state
// reasoning expansion policy in reasoningExpansionPolicy.ts, which owns the
// storage key ("reasonix-default-collapsed") and the event.
//
// The boolean stays because older callers (and their tests) still ask
// "should inner items start collapsed?":
//
//   getDefaultCollapsed() === true   ⟺  policy === "all-collapsed"
//   getDefaultCollapsed() === false  ⟺  policy is "latest-only" or "all-expanded"
//
// New code should read the policy directly: it needs the third state to decide
// whether only the newest item opens. Writing through this shim maps a boolean
// back onto the two policies the boolean can express.
import { useSyncExternalStore } from "react";
import {
  getReasoningExpansionPolicy,
  setReasoningExpansionPolicy,
} from "./reasoningExpansionPolicy";

export function getDefaultCollapsed(): boolean {
  return getReasoningExpansionPolicy() === "all-collapsed";
}

export function setDefaultCollapsed(value: boolean): void {
  setReasoningExpansionPolicy(value ? "all-collapsed" : "all-expanded");
}

export function toggleDefaultCollapsed(): boolean {
  const next = !getDefaultCollapsed();
  setDefaultCollapsed(next);
  return next;
}

export function useDefaultCollapsed(): boolean {
  // Same store and event as the policy, so a toggle re-renders every caller.
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === "undefined") return () => {};
      const handler = () => listener();
      window.addEventListener("reasonix:reasoning-expansion-policy", handler);
      return () => window.removeEventListener("reasonix:reasoning-expansion-policy", handler);
    },
    getDefaultCollapsed,
    getDefaultCollapsed,
  );
}
