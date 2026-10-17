// Pure expansion-decision helpers for the transcript's INNER items
// (reasoning blocks, tool cards, sub-agent reasoning).
//
// This module is deliberately side-effect free: it answers "should this item
// be open right now?" so both the reasoning components and the unit tests can
// exercise the same rules without a DOM. It owns three things:
//
//   1. Whether an item is the one that currently produces output. This is a
//      MODEL-level fact (item identity + row order), never a component's own
//      `streaming` flag: a stopped-but-not-yet-cleared block still reports
//      streaming, and a block cannot see where it sits in the whole session.
//   2. The auto open/close decision for one of the three expansion policies.
//   3. Manual-toggle precedence: once the user toggles an item, streaming
//      token updates must never silently flip it back.
//
// Priority (high → low):
//   deep experience (backend authoritative) > policy > initial default.
// A manual toggle outranks everything and is remembered by the caller.

import type { ReasoningExpansionPolicy } from "./reasoningExpansionPolicy";
import type { SessionExperience } from "./sessionExperience";

/** What one inner item needs to decide its expansion state. */
export interface ReasoningExpansionInput {
  /** Deep keeps every inner item expanded regardless of the policy. */
  experience: SessionExperience;
  policy: ReasoningExpansionPolicy;
  /**
   * True when this very item still produces output. Callers derive it from
   * the authoritative live stream plus the row model's global ordering —
   * never from the item's own `streaming` flag alone.
   */
  producing: boolean;
  /**
   * True when this is the newest item of its kind in the session. Under
   * `latest-only` a settled newest item may stay expanded after generation
   * ends, while every older one folds.
   */
  isLatest: boolean;
  /** The session experience keeps work expanded after completion. */
  keepExpandedAfterCompletion: boolean;
  /** The process is shown while it runs. */
  showWhileRunning: boolean;
}

/** The policy-derived default, before any manual toggle. */
export function defaultReasoningExpansionOpen(input: ReasoningExpansionInput): boolean {
  // Deep is the backend-authoritative experience and must not be overridden
  // by a local presentation preference.
  if (input.experience === "deep" || input.keepExpandedAfterCompletion) return true;
  if (input.policy === "all-collapsed") return false;
  if (input.policy === "all-expanded") return true;
  // latest-only: the producing item is open; a settled newest item stays open
  // while the turn runs so the reader keeps the block they were reading.
  return input.producing || input.isLatest;
}

/** True when a policy or experience change must re-apply the defaults. */
export function expansionPreferenceChanged(
  previous: { experience: SessionExperience; policy: ReasoningExpansionPolicy },
  next: { experience: SessionExperience; policy: ReasoningExpansionPolicy },
): boolean {
  return previous.experience !== next.experience || previous.policy !== next.policy;
}

/**
 * Advance one item's expansion state for the current frame.
 *
 * `wasProducing`/`wasLatest` are the previous frame's values, so a change of
 * identity (a newer item took over) can fold this one without reacting to the
 * streaming text itself — token updates keep both values stable.
 */
export function reconcileReasoningExpansion(
  previous: { open: boolean; userOverridden: boolean; wasProducing: boolean; wasLatest: boolean },
  input: ReasoningExpansionInput,
): { open: boolean; userOverridden: boolean } {
  // Deep keeps work expanded, but a manual collapse still wins.
  if (input.experience === "deep" || input.keepExpandedAfterCompletion) {
    return previous.userOverridden
      ? { open: previous.open, userOverridden: true }
      : { open: true, userOverridden: false };
  }
  // A manual toggle outranks the policy for as long as the policy stays put.
  if (previous.userOverridden) return { open: previous.open, userOverridden: true };
  const next = defaultReasoningExpansionOpen(input);
  return { open: next, userOverridden: false };
}

/** A newer item took over: fold this one unless the user opened it by hand. */
export function foldSupersededItem(previous: { open: boolean; userOverridden: boolean }): { open: boolean; userOverridden: boolean } {
  if (previous.userOverridden) return previous;
  return { open: false, userOverridden: false };
}

/** A user toggle is always remembered, whatever the policy says. */
export function withManualToggle(previous: { open: boolean }): { open: boolean; userOverridden: boolean } {
  return { open: !previous.open, userOverridden: true };
}

/** Reset a manual choice because the policy or the experience changed. */
export function clearManualOverride(previous: { open: boolean }): { open: boolean; userOverridden: false } {
  void previous;
  return { open: false, userOverridden: false };
}
