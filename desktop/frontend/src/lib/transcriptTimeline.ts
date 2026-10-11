import type { TranscriptRowWithLayout } from "./transcriptRows";

export type TimelineBlock = {
  key: string;
  turn?: number;
  phase: "completed" | "active";
  rows: readonly TranscriptRowWithLayout[];
  contentRevision: number;
  measurementRevision: string;
  questionAnchor?: string;
};

export type TimelineProjection = {
  completedBlocks: readonly TimelineBlock[];
  activeBlock?: TimelineBlock;
  hasOlderHistory: boolean;
};

export type TranscriptRenderMode = "full" | "windowed";

export const TRANSCRIPT_WINDOW_THRESHOLD_TURNS = 100;
export const TRANSCRIPT_RESIDENT_COMPLETED_TURNS = 2;

export function projectTranscriptTimeline(
  blocks: readonly TimelineBlock[],
  hasOlderHistory: boolean,
): TimelineProjection {
  let activeBlock: TimelineBlock | undefined;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].phase === "active") {
      activeBlock = blocks[index];
      break;
    }
  }
  return {
    completedBlocks: blocks.filter((block) => block.phase === "completed"),
    activeBlock,
    hasOlderHistory,
  };
}

export function defaultTranscriptRenderMode(completedTurns: number): TranscriptRenderMode {
  return completedTurns > TRANSCRIPT_WINDOW_THRESHOLD_TURNS ? "windowed" : "full";
}

function diagnosticsOverrideAllowed(): boolean {
  const channel = typeof __BUILD_CHANNEL__ === "string" ? __BUILD_CHANNEL__ : "development";
  return channel === "test" || channel === "preview" || channel === "canary" || Boolean(import.meta.env?.DEV);
}

export function transcriptRenderMode(
  completedTurns: number,
  safeMode: boolean,
  search = typeof window === "undefined" ? "" : window.location.search,
): TranscriptRenderMode {
  return resolveTranscriptRenderMode(completedTurns, safeMode, transcriptRenderModeOverride(search));
}

export function resolveTranscriptRenderMode(
  completedTurns: number,
  safeMode: boolean,
  requested?: TranscriptRenderMode,
  autoWindowed = false,
): TranscriptRenderMode {
  if (safeMode) return "full";
  if (requested) return requested;
  return autoWindowed ? "windowed" : defaultTranscriptRenderMode(completedTurns);
}

export function shouldAutoWindowTranscript(safeMode: boolean, requested: TranscriptRenderMode | undefined, volumeExceeded: boolean): boolean {
  return !safeMode && !requested && volumeExceeded;
}

export function transcriptRenderModeOverride(
  search = typeof window === "undefined" ? "" : window.location.search,
): TranscriptRenderMode | undefined {
  if (!diagnosticsOverrideAllowed()) return undefined;
  const requested = new URLSearchParams(search).get("transcriptRenderMode");
  return requested === "full" || requested === "windowed" ? requested : undefined;
}

export function splitWindowedTimeline(projection: TimelineProjection): {
  cold: readonly TimelineBlock[];
  resident: readonly TimelineBlock[];
} {
  const split = Math.max(0, projection.completedBlocks.length - TRANSCRIPT_RESIDENT_COMPLETED_TURNS);
  return {
    cold: projection.completedBlocks.slice(0, split),
    resident: projection.completedBlocks.slice(split),
  };
}
