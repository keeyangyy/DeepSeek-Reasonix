// Fold state of the transcript's work-process groups ("N tools · M thoughts").
//
// The fold semantics used to live inside the per-instance TurnCollapse state
// and then inside transcriptRows.ts. They now own a module of their own: the
// policy-aware defaults, the reconciliation state machine, and the segment
// projection it consumes (structural, so this module does not depend on the
// row model that owns TurnModel).
//
// Folding is a DISPLAY ownership question, not a data question: a fold that is
// closed contributes no rows to the virtual row model, so an open fold mounts
// its body rows only when scrolled into view.

import type { SessionExperience } from "./sessionExperience";
import type { ProcessFoldPolicy } from "./processFoldPolicy";
import type { ProcessFoldPreference } from "./processFoldPreference";
import type { ResolvedReasoningDisplayMode } from "./reasoningDisplayPreference";

export interface FoldEntry {
  open: boolean;
  userOverridden: boolean;
  running: boolean;
  keepReasoningExpanded?: boolean;
}

export type FoldMap = ReadonlyMap<string, FoldEntry>;

export const EMPTY_FOLDS: FoldMap = new Map();

type ExperienceInput = SessionExperience | ProcessFoldPreference | ResolvedReasoningDisplayMode;

function normalizeExperience(value: ExperienceInput): SessionExperience {
  return value === "deep" || value === "expanded" ? "deep" : "standard";
}

/**
 * The default open state of one process fold.
 *
 * `follow-turn` is the long-standing behavior: a fold of the running turn
 * stays open and a settled turn folds closed. `collapsed` closes every fold,
 * and `active-only` keeps just the segment that still produces output open.
 * Deep — and an explicitly pinned reasoning fold — always shows the process,
 * so the policy only refines the default (standard) experience.
 */
export function defaultFoldOpen(
  segment: {
    hasOutsideContent: boolean;
    hasRunningWork: boolean;
    /** Segment-level activity (segment.hasRunningWork on a SegmentModel). */
    selfRunning?: boolean;
    foldActive?: boolean;
    keepReasoningExpanded?: boolean;
  },
  experience: ExperienceInput,
  policy: ProcessFoldPolicy = "follow-turn",
): boolean {
  const normalized = normalizeExperience(experience);
  if (normalized === "deep" || segment.keepReasoningExpanded === true) return true;
  if (policy === "collapsed") return false;
  if (policy === "active-only") return segment.selfRunning ?? segment.hasRunningWork;
  return !segment.hasOutsideContent || segment.foldActive === true || segment.hasRunningWork;
}

export interface FoldSegmentState {
  key: string;
  hasOutsideContent: boolean;
  /** Turn-level activity: the segment belongs to a running turn, or it works itself. */
  hasRunningWork: boolean;
  /** Segment-level activity: this very segment still produces output. */
  selfRunning: boolean;
  /** This segment is the last one of a turn that is still running. */
  turnActive: boolean;
  keepReasoningExpanded: boolean;
}

/** The segment fields the fold projection reads. */
export interface FoldSegmentSource {
  key: string;
  hasOutsideContent: boolean;
  foldActive: boolean;
  hasRunningWork: boolean;
  turnActive: boolean;
  displayItems: readonly { kind: string }[];
}

export function foldSegmentStates(
  models: readonly { segments: readonly FoldSegmentSource[] }[],
  keepReasoningExpanded = false,
): FoldSegmentState[] {
  const out: FoldSegmentState[] = [];
  for (const model of models) {
    for (const segment of model.segments) {
      if (segment.displayItems.length === 0) continue;
      out.push({
        key: segment.key,
        hasOutsideContent: segment.hasOutsideContent,
        hasRunningWork: segment.foldActive,
        selfRunning: segment.hasRunningWork,
        turnActive: segment.turnActive,
        keepReasoningExpanded: keepReasoningExpanded && segment.displayItems.some((item) => item.kind === "assistant"),
      });
    }
  }
  return out;
}

/**
 * Advance the fold map to match the current segments. Mirrors the old
 * per-TurnCollapse effects: a fold auto-opens while its turn runs and
 * auto-closes on completion unless the user toggled it, it has nothing
 * outside, or the preference pins every fold open. A preference switch clears
 * per-fold overrides so the whole transcript lands in one consistent state.
 * Returns null when nothing changed (so callers can skip a re-render).
 */
export function reconcileFoldEntries(
  prev: FoldMap,
  segments: readonly FoldSegmentState[],
  experience: ExperienceInput,
  preferenceChanged: boolean,
  policy: ProcessFoldPolicy = "follow-turn",
): Map<string, FoldEntry> | null {
  const normalizedExperience = normalizeExperience(experience);
  // The policy-aware default for one segment; "follow-turn" keeps the
  // historical behavior, the other policies only refine it.
  const autoOpen = (segment: FoldSegmentState) => defaultFoldOpen(segment, normalizedExperience, policy);
  let next: Map<string, FoldEntry> | null = null;
  const write = (key: string, entry: FoldEntry) => {
    if (!next) next = new Map(prev);
    next.set(key, entry);
  };
  const seen = new Set<string>();
  for (const segment of segments) {
    seen.add(segment.key);
    const entry = prev.get(segment.key);
    if (!entry) {
      write(segment.key, {
        open: autoOpen(segment),
        userOverridden: false,
        running: segment.hasRunningWork,
        keepReasoningExpanded: segment.keepReasoningExpanded,
      });
      continue;
    }
    const reasoningPinChanged = Boolean(entry.keepReasoningExpanded) !== segment.keepReasoningExpanded;
    if (preferenceChanged || reasoningPinChanged) {
      const open = autoOpen(segment);
      if (open !== entry.open || entry.userOverridden || entry.running !== segment.hasRunningWork || reasoningPinChanged) {
        write(segment.key, {
          open,
          userOverridden: false,
          running: segment.hasRunningWork,
          keepReasoningExpanded: segment.keepReasoningExpanded,
        });
      }
      continue;
    }
    if (segment.hasRunningWork) {
      // A fresh run clears the previous manual toggle; while the turn runs the
      // fold follows the policy unless the user toggled it during THIS run.
      // "follow-turn" opens every segment of the running turn; "active-only"
      // opens just the segment still producing output.
      const userOverridden = entry.running ? entry.userOverridden : false;
      const open = userOverridden ? entry.open : policy === "follow-turn" ? true : autoOpen(segment);
      if (open !== entry.open || userOverridden !== entry.userOverridden || !entry.running) {
        write(segment.key, { open, userOverridden, running: true, keepReasoningExpanded: segment.keepReasoningExpanded });
      }
      continue;
    }
    if (entry.running) {
      const open = entry.userOverridden
        ? entry.open
        : policy !== "follow-turn"
          ? autoOpen(segment)
          : segment.hasOutsideContent && normalizedExperience !== "deep" && !segment.keepReasoningExpanded ? false : entry.open;
      write(segment.key, {
        open,
        userOverridden: entry.userOverridden,
        running: false,
        keepReasoningExpanded: segment.keepReasoningExpanded,
      });
    }
  }
  for (const key of prev.keys()) {
    if (!seen.has(key)) {
      if (!next) next = new Map(prev);
      next.delete(key);
    }
  }
  return next;
}

/** User clicked a fold header: flip it and mark the choice as deliberate. */
export function foldMapWithToggle(prev: FoldMap, key: string, currentlyOpen: boolean): Map<string, FoldEntry> {
  const next = new Map(prev);
  const entry = prev.get(key);
  next.set(key, {
    open: !currentlyOpen,
    userOverridden: true,
    running: entry?.running ?? false,
    keepReasoningExpanded: entry?.keepReasoningExpanded,
  });
  return next;
}

/** Preserve an inner reasoning expansion when the enclosing process fold settles. */
export function foldMapWithReasoningOpen(prev: FoldMap, key: string, running: boolean): Map<string, FoldEntry> {
  const next = new Map(prev);
  const entry = prev.get(key);
  next.set(key, {
    open: true,
    userOverridden: true,
    running: entry?.running ?? running,
    keepReasoningExpanded: entry?.keepReasoningExpanded,
  });
  return next;
}