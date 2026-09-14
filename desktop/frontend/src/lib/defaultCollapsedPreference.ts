// defaultCollapsedPreference is a frontend-only preference: when enabled, the
// transcript renders reasoning / tool / sub-agent work collapsed to one line by
// default (no auto-expand while running). Manual expand/collapse per item is
// unaffected — the preference only changes the initial/open-after-reset state.
//
// Deliberately kept out of the backend SessionExperience contract (standard /
// deep): this fork adds a "start collapsed" experience without widening the
// official two-mode model, so the setting stays local and is trivially
// reversible by clearing the key.
import { useSyncExternalStore } from "react";

const DEFAULT_COLLAPSED_KEY = "reasonix-default-collapsed";
const DEFAULT_COLLAPSED_EVENT = "reasonix:default-collapsed";

let current = typeof window !== "undefined" && typeof localStorage !== "undefined"
  ? localStorage.getItem(DEFAULT_COLLAPSED_KEY) === "1"
  : false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DEFAULT_COLLAPSED_EVENT, { detail: current }));
  }
}

export function getDefaultCollapsed(): boolean {
  return current;
}

export function setDefaultCollapsed(value: boolean): void {
  const next = Boolean(value);
  if (next === current) return;
  current = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(DEFAULT_COLLAPSED_KEY, next ? "1" : "0");
  }
  emit();
}

export function toggleDefaultCollapsed(): boolean {
  const next = !current;
  setDefaultCollapsed(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDefaultCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getDefaultCollapsed, getDefaultCollapsed);
}
