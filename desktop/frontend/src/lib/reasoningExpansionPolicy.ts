// reasoningExpansionPolicy is a frontend-only preference for how the
// transcript's INNER items — reasoning blocks, tool cards and sub-agent
// reasoning — start out:
//
//   all-collapsed — every inner item starts collapsed, including the one
//                   producing output; a manual toggle still wins.
//   latest-only   — only the item still producing output stays expanded; a
//                   newer item expands and folds the previous one. Once the
//                   generation ends, the newest item may stay expanded.
//   all-expanded  — every inner item starts expanded.
//
// Deliberately kept out of the backend SessionExperience contract (standard /
// deep), like the work-process fold policy: this fork adds a local
// presentation preference without widening the official two-mode model. Deep
// keeps its meaning (work stays expanded), so the policy is inert there.
//
// The legacy boolean "start collapsed" preference shares the SAME storage key
// so an existing install migrates without a script:
//   "1"           → all-collapsed   (old start-collapsed = on)
//   "0" / missing → latest-only     (old start-collapsed = off: the running
//                    item opened and, once done, nothing stayed open)
//   anything else → latest-only     (the default, so an untouched install
//                    keeps the running item open and folds the rest)
//
// all-expanded is deliberately NOT the default: it is a new, stronger
// behavior ("never fold anything") that a user has to pick on purpose, so
// upgrading does not silently unfold a whole session.
import { useSyncExternalStore } from "react";

export type ReasoningExpansionPolicy = "all-collapsed" | "latest-only" | "all-expanded";

const EXPANSION_POLICY_KEY = "reasonix-default-collapsed";
const EXPANSION_POLICY_EVENT = "reasonix:reasoning-expansion-policy";

/** Ordered least → most expanded. The settings UI renders in this order. */
export const REASONING_EXPANSION_POLICIES: readonly ReasoningExpansionPolicy[] = ["all-collapsed", "latest-only", "all-expanded"];

function normalizePolicy(value: unknown): ReasoningExpansionPolicy {
  if (value === "all-collapsed" || value === "latest-only" || value === "all-expanded") return value;
  // Legacy boolean storage: "1" meant "start collapsed". Everything else —
  // including a missing key and any value an older build could not have
  // written — is the latest-only default.
  if (value === "1") return "all-collapsed";
  return "latest-only";
}

function storedPolicy(): ReasoningExpansionPolicy {
  // "No storage available" behaves exactly like "no preference stored": the
  // latest-only default. Reading it at module init is intentional, but the
  // fallback must not assume a stronger behavior than a fresh install has.
  if (typeof localStorage === "undefined") return "latest-only";
  return normalizePolicy(localStorage.getItem(EXPANSION_POLICY_KEY));
}

let current: ReasoningExpansionPolicy = storedPolicy();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EXPANSION_POLICY_EVENT, { detail: current }));
  }
}

export function getReasoningExpansionPolicy(): ReasoningExpansionPolicy {
  return current;
}

export function setReasoningExpansionPolicy(policy: ReasoningExpansionPolicy): void {
  const next = normalizePolicy(policy);
  if (next === current) return;
  current = next;
  if (typeof localStorage !== "undefined") localStorage.setItem(EXPANSION_POLICY_KEY, next);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReasoningExpansionPolicy(): ReasoningExpansionPolicy {
  return useSyncExternalStore(subscribe, getReasoningExpansionPolicy, getReasoningExpansionPolicy);
}
