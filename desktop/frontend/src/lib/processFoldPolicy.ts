// processFoldPolicy is a frontend-only preference for how a turn's work
// process is folded into the "N tools · M thoughts" group headers:
//
//   follow-turn — the running turn keeps its groups open and a settled turn
//                 folds them. This is the long-standing behavior and the
//                 default, so an untouched install renders exactly as before.
//   collapsed   — every group starts folded, including the one producing
//                 output; a manual toggle still wins.
//   active-only — only the group producing output right now stays open. A
//                 group that already settled inside the running turn folds
//                 immediately instead of waiting for the turn to end.
//
// Deliberately kept out of the backend SessionExperience contract (standard /
// deep), like "start collapsed": this fork adds a local presentation
// preference without widening the official two-mode model. "Deep" keeps its
// meaning (work stays expanded), so the policy is inert there.
import { useSyncExternalStore } from "react";

export type ProcessFoldPolicy = "follow-turn" | "collapsed" | "active-only";

const PROCESS_FOLD_POLICY_KEY = "reasonix-process-fold-policy";
const PROCESS_FOLD_POLICY_EVENT = "reasonix:process-fold-policy";

function normalizePolicy(value: unknown): ProcessFoldPolicy {
  return value === "collapsed" || value === "active-only" ? value : "follow-turn";
}

function storedPolicy(): ProcessFoldPolicy {
  if (typeof localStorage === "undefined") return "follow-turn";
  return normalizePolicy(localStorage.getItem(PROCESS_FOLD_POLICY_KEY));
}

let current: ProcessFoldPolicy = storedPolicy();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROCESS_FOLD_POLICY_EVENT, { detail: current }));
  }
}

export function getProcessFoldPolicy(): ProcessFoldPolicy {
  return current;
}

export function setProcessFoldPolicy(policy: ProcessFoldPolicy): void {
  const next = normalizePolicy(policy);
  if (next === current) return;
  current = next;
  if (typeof localStorage !== "undefined") localStorage.setItem(PROCESS_FOLD_POLICY_KEY, next);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProcessFoldPolicy(): ProcessFoldPolicy {
  return useSyncExternalStore(subscribe, getProcessFoldPolicy, getProcessFoldPolicy);
}