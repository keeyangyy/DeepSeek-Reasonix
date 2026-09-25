import type { WireEvent } from "./types";
import type { LiveStream } from "./useController";

// A delta's tab identity at enqueue time. A same-tab reset / newSession /
// switch re-binds the tab to another session, and a frame callback that flushes
// afterwards would otherwise splice the previous session's text/reasoning into
// the new transcript (the "older content after newer content" report).
export interface StreamDeltaEntry {
  tabId: string;
  e: WireEvent;
  sessionGeneration?: number;
  runtimeEpoch?: string;
}

export interface StreamDeltaTabIdentity {
  sessionGeneration?: number;
  runtimeEpoch?: string;
}

// filterStaleStreamDeltas drops entries whose tab no longer carries the identity
// they were enqueued against. Entries without a recorded identity keep their
// existing behaviour, and an unresolvable tab is left untouched so a tab that
// has not registered yet cannot lose its live stream.
export function filterStaleStreamDeltas(
  batch: StreamDeltaEntry[],
  resolve: (tabId: string) => StreamDeltaTabIdentity | undefined,
): StreamDeltaEntry[] {
  if (!batch.some((entry) => entry.sessionGeneration !== undefined || entry.runtimeEpoch !== undefined)) return batch;
  return batch.filter((entry) => {
    const current = resolve(entry.tabId);
    if (!current) return true;
    if (entry.sessionGeneration !== undefined && current.sessionGeneration !== undefined &&
      current.sessionGeneration !== entry.sessionGeneration) return false;
    if (entry.runtimeEpoch !== undefined && current.runtimeEpoch !== undefined &&
      current.runtimeEpoch !== entry.runtimeEpoch) return false;
    return true;
  });
}

// StreamSegment is one run of consecutive same-kind deltas within a frame.
// Segment order is authoritative: a reasoning→text boundary completes
// reasoning exactly as per-delta delivery would, so kinds are never bucketed.
export interface StreamSegment {
  kind: "text" | "reasoning";
  delta: string;
}

export interface TabStreamBatch {
  tabId: string;
  segments: StreamSegment[];
}

// coalesceStreamDeltas groups one rAF batch by tab and merges consecutive
// same-kind deltas into ordered segments, so a frame dispatches one
// stream_batch action (one reducer pass, one live-store notification) per tab
// no matter how many token deltas the bridge delivered. Tabs are independent
// state machines, so per-tab grouping cannot reorder anything observable.
// Empty deltas are kept: an empty text delta still completes live reasoning.
export function coalesceStreamDeltas(batch: StreamDeltaEntry[]): TabStreamBatch[] {
  const out: TabStreamBatch[] = [];
  const byTab = new Map<string, StreamSegment[]>();
  for (const { tabId, e } of batch) {
    const kind = e.kind === "reasoning" ? "reasoning" : "text";
    const delta = e.text ?? e.reasoning ?? "";
    let segments = byTab.get(tabId);
    if (!segments) {
      segments = [];
      byTab.set(tabId, segments);
      out.push({ tabId, segments });
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.delta += delta;
    else segments.push({ kind, delta });
  }
  return out;
}

export function completeLiveReasoning(live: LiveStream, now = Date.now()): LiveStream {
  if (!live.reasoning || live.reasoningCompletedAt) {
    return { ...live, reasoningComplete: live.reasoning !== "" || live.reasoningComplete };
  }
  return {
    ...live,
    reasoningComplete: true,
    reasoningCompletedAt: now,
  };
}

// applyLiveSegments folds one frame's ordered segments into the live stream,
// replicating per-delta semantics: text completes reasoning first; reasoning
// reopens it and stamps its start on the first non-empty delta.
export function applyLiveSegments(base: LiveStream, segments: StreamSegment[], now: number): LiveStream {
  let live = base;
  for (const seg of segments) {
    live =
      seg.kind === "text"
        ? { ...completeLiveReasoning(live, now), text: live.text + seg.delta }
        : {
            ...live,
            reasoning: live.reasoning + seg.delta,
            reasoningComplete: false,
            reasoningStartedAt: live.reasoningStartedAt ?? (seg.delta ? now : undefined),
            reasoningCompletedAt: undefined,
          };
  }
  return live;
}
