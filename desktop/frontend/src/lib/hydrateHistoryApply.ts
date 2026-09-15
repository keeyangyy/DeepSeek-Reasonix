/** Live-turn markers that a lagging history snapshot must not replace. */
export type HydrateLiveState = {
  running?: boolean;
  turnActive?: boolean;
  live?: unknown;
  currentAssistant?: unknown;
  pendingUser?: unknown;
  historyTotalTurns?: number;
  items: ReadonlyArray<{ kind: string; streaming?: boolean; status?: string }>;
  historyRevision?: number;
  historyDigest?: string;
};

export type HydratedHistoryApplyMode = "replace" | "prepend" | "skip";

export type HydrateProjection = {
  items: ReadonlyArray<unknown>;
  revision?: number;
  digest?: string;
};

export type SessionHydrateIdentity = {
  sessionPath?: string;
  sessionGeneration?: number;
};

export type HydrateSurfacePolicy = "preserve-current" | "replace-surface";

type ActiveTabHydrationTarget = SessionHydrateIdentity & {
  sessionRevision?: number;
  sessionDigest?: string;
};

export type ActiveTabHydrationLoadOptions = ActiveTabHydrationTarget & {
  preserveCachedHistory: boolean;
  surfacePolicy?: HydrateSurfacePolicy;
};

export function activeTabHydrationPlan(
  target: ActiveTabHydrationTarget,
  current: SessionHydrateIdentity | undefined,
  reset: boolean,
  requestedPolicy?: HydrateSurfacePolicy,
  requestedCache?: boolean,
): {
  sameSession: boolean;
  surfacePolicy: HydrateSurfacePolicy;
  loadOptions: ActiveTabHydrationLoadOptions;
} {
  const sameSession = sameSessionHydrateIdentity(target, current);
  const surfacePolicy = requestedPolicy ?? (sameSession ? "preserve-current" : "replace-surface");
  if (surfacePolicy === "replace-surface") {
    return {
      sameSession,
      surfacePolicy,
      loadOptions: {
        preserveCachedHistory: false,
        surfacePolicy,
        sessionPath: target.sessionPath,
        sessionRevision: target.sessionRevision,
        sessionDigest: target.sessionDigest,
        sessionGeneration: target.sessionGeneration,
      },
    };
  }
  return {
    sameSession,
    surfacePolicy,
    loadOptions: {
      preserveCachedHistory: sameSession && (requestedCache ?? !reset),
      sessionPath: target.sessionPath,
      sessionRevision: target.sessionRevision,
      sessionDigest: target.sessionDigest,
    },
  };
}

type UnboundLiveSurfaceState = HydrateLiveState & {
  hydrateHistoryLoaded?: boolean;
};

/** A surface may retain content only when the target session is provably the same. */
export function sameSessionHydrateIdentity(
  target: SessionHydrateIdentity | undefined,
  current: SessionHydrateIdentity | undefined,
): boolean {
  const targetPath = (target?.sessionPath ?? "").trim();
  const currentPath = (current?.sessionPath ?? "").trim();
  if (!targetPath || !currentPath || targetPath !== currentPath) return false;
  if (
    target?.sessionGeneration !== undefined &&
    current?.sessionGeneration !== undefined &&
    target.sessionGeneration !== current.sessionGeneration
  ) return false;
  return true;
}

/**
 * Adopt only a live runtime tail that has never been bound to persisted
 * history. This is the compatibility bridge for background runtime events
 * that predate the tab metadata snapshot: it must never retain a resident
 * transcript merely because the tab id matches.
 */
export function canAdoptUnboundLiveSurface(
  target: SessionHydrateIdentity | undefined,
  current: SessionHydrateIdentity | undefined,
  state: UnboundLiveSurfaceState | undefined,
  backendRunning: boolean,
  targetRuntimeEpoch?: string,
  currentRuntimeEpoch?: string,
): boolean {
  if (!backendRunning || !state) return false;
  if (!(target?.sessionPath ?? "").trim()) return false;
  if ((current?.sessionPath ?? "").trim()) return false;
  if (state.hydrateHistoryLoaded || (state.historyTotalTurns ?? 0) > 0) return false;
  if (state.historyRevision !== undefined || (state.historyDigest ?? "").trim()) return false;
  if (!state.running && !state.turnActive) return false;
  if (targetRuntimeEpoch && currentRuntimeEpoch && targetRuntimeEpoch !== currentRuntimeEpoch) return false;
  return Boolean(
    state.live ||
    state.currentAssistant ||
    state.pendingUser !== undefined ||
    state.items.some((item) =>
      (item.kind === "assistant" && item.streaming) ||
      (item.kind === "tool" && item.status === "running"),
    ),
  );
}

export function shouldPreferResidentHistory(reset: boolean, preserveCachedHistory?: boolean): boolean {
  return !reset && preserveCachedHistory !== false;
}

function sameHydrateFingerprint(state: HydrateLiveState | undefined, projection: HydrateProjection | undefined): boolean {
  if (!state || !projection) return false;
  const revision = projection.revision ?? 0;
  const digest = (projection.digest ?? "").trim();
  if (revision > 0 && state.historyRevision === revision) return true;
  if (digest !== "" && (state.historyDigest ?? "") === digest) return true;
  return false;
}

export function isStaleResidentProjection(
  state: HydrateLiveState | undefined,
  projection: HydrateProjection | undefined,
): boolean {
  if (!state || !projection || state.items.length === 0) return false;
  if (projection.items.length >= state.items.length) return false;
  return sameHydrateFingerprint(state, projection);
}

// A live turn is only "cached" once a history page has landed behind it.
// Without that, a session opened mid-stream reports a cached turn, skips the
// fetch, and streams over a blank transcript.
export function hasCachedLiveTurn(state: HydrateLiveState | undefined): boolean {
  if (!state?.running && !state?.turnActive) return false;
  if ((state.historyTotalTurns ?? 0) === 0) return false;
  if (state.live || state.currentAssistant || state.pendingUser !== undefined) return true;
  return state.items.some((item) =>
    (item.kind === "assistant" && item.streaming) ||
    (item.kind === "tool" && item.status === "running"),
  );
}

export function hasReusableCachedTranscript(
  state: (HydrateLiveState & { meta?: SessionHydrateIdentity }) | undefined,
  sessionPath?: string,
  revision?: number,
  digest?: string,
): boolean {
  if (!state || state.items.length === 0 || state.historyTotalTurns === 0) return false;
  const expectedSessionPath = (sessionPath ?? "").trim();
  if (!expectedSessionPath) return true;
  if ((state.meta?.sessionPath ?? "").trim() !== expectedSessionPath) return false;
  if (typeof revision === "number" && revision > 0) {
    return state.historyRevision === revision && (digest ?? "") === (state.historyDigest ?? "");
  }
  if ((digest ?? "").trim() !== "") return state.historyDigest === digest;
  // Missing backend fingerprints must not bless a resident page that already
  // has one; the sidecar may be between atomic replacements.
  return state.historyRevision === undefined && !state.historyDigest;
}

// An empty surface has to apply history or switch-back shows Welcome. A turn
// that has already streamed rows keeps them — but a tab with no history page
// behind it still gets one, prepended, instead of a blank transcript above the
// live turn. Only an already-hydrated live turn is left alone. An idle
// same-fingerprint resident page that is shorter than the visible transcript
// is skipped so Retry/clear cannot roll the chat back.
export function hydratedHistoryApplyMode(
  skipHistory: boolean,
  hasProjection: boolean,
  foregroundTurnActive: boolean,
  state: HydrateLiveState | undefined,
  projection?: HydrateProjection,
): HydratedHistoryApplyMode {
  if (skipHistory || !hasProjection) return "skip";
  if (!foregroundTurnActive) return isStaleResidentProjection(state, projection) ? "skip" : "replace";
  if ((state?.items.length ?? 0) === 0 && !hasCachedLiveTurn(state)) return "replace";
  return (state?.historyTotalTurns ?? 0) === 0 ? "prepend" : "skip";
}

type SignatureItem = {
  kind: string;
  id: string;
  text?: string;
  reasoning?: string;
  name?: string;
  level?: string;
  trigger?: string;
  messages?: number;
  surfaceKey?: string;
  generation?: number;
};

function itemSignature(item: SignatureItem): string {
  switch (item.kind) {
    case "tool": return `tool|${item.id}|${item.name ?? ""}`;
    case "extension": return `extension|${item.surfaceKey ?? ""}|${item.generation ?? 0}`;
    case "compaction": return `compaction|${item.trigger ?? ""}|${item.messages ?? 0}`;
    default: return `${item.kind}|${item.level ?? ""}|${item.text ?? ""}|${item.reasoning ?? ""}`;
  }
}

// A page read while its turn is live can already carry rows the live stream
// rendered. Only a suffix of the page can overlap a prefix of the live rows, so
// the longest such match is the duplicate set.
export function duplicateLiveItemIds(
  pageItems: readonly SignatureItem[],
  liveItems: readonly SignatureItem[],
): string[] {
  for (let k = Math.min(pageItems.length, liveItems.length); k > 0; k -= 1) {
    let same = true;
    for (let i = 0; i < k && same; i += 1) {
      same = itemSignature(pageItems[pageItems.length - k + i]) === itemSignature(liveItems[i]);
    }
    if (same) return liveItems.slice(0, k).map((item) => item.id);
  }
  return [];
}

export type AlignableRow = { kind: string; id: string; text?: string };

/** Indexes of the user rows, the only rows that start a turn. */
function turnAnchorIndexes(rows: readonly AlignableRow[]): number[] {
  const anchors: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind === "user") anchors.push(i);
  }
  return anchors;
}

function anchorPrompt(rows: readonly AlignableRow[], anchor: number): string {
  return (rows[anchor]?.text ?? "").trim();
}

/**
 * Ids of the page rows the live surface already owns.
 *
 * The persisted snapshot of an in-flight turn is always a prefix of what the
 * live surface renders, and a live assistant row carries no text at all — the
 * streaming body lives in LiveStream, not in `items`. Per-row text signatures
 * therefore cannot align the two sources: `itemSignature` collapses every live
 * assistant row to `assistant|||` and the whole-page match in
 * `duplicateLiveItemIds` never fires, so the page is prepended on top of the
 * live copy of the same turn.
 *
 * The turn anchor — a user row, whose prompt text is real on both sides — is
 * the only comparable unit. Walking back from both tails over those anchors
 * finds the turns the two sources share, and the page copy of a shared turn
 * yields to the live copy: while the turn is in flight the live rows are the
 * newer representation, since the page can only carry what was flushed to
 * disk mid-stream. Rows before the first shared turn are kept; they are older
 * history the live surface does not have.
 */
export function liveOwnedPageTailIds(
  pageItems: readonly AlignableRow[],
  liveItems: readonly AlignableRow[],
): string[] {
  if (pageItems.length === 0 || liveItems.length === 0) return [];
  const pageAnchors = turnAnchorIndexes(pageItems);
  const liveAnchors = turnAnchorIndexes(liveItems);
  if (pageAnchors.length > 0 && liveAnchors.length > 0) {
    let shared = 0;
    while (shared < pageAnchors.length && shared < liveAnchors.length) {
      const pagePrompt = anchorPrompt(pageItems, pageAnchors[pageAnchors.length - 1 - shared]);
      // An empty prompt cannot prove two turns are the same one.
      if (pagePrompt === "") break;
      if (pagePrompt !== anchorPrompt(liveItems, liveAnchors[liveAnchors.length - 1 - shared])) break;
      shared += 1;
    }
    if (shared > 0) {
      return pageItems.slice(pageAnchors[pageAnchors.length - shared]).map((item) => item.id);
    }
  }
  return liveMidTurnOwnedPageIds(pageItems, liveItems);
}

/**
 * Ids of the page rows a mid-turn live surface already owns.
 *
 * A replay that rebuilds the active turn recreates its assistant/tool rows but
 * NOT its user row: the user row comes from the local submission, and the
 * replay stream has no event for it (`turn_started` carries only the
 * submissionId). A live surface that holds assistant/tool rows but no user
 * anchor is therefore mid-turn, so the anchor walk above cannot align it and
 * returns nothing — the page is then prepended whole, laying down a second copy
 * of the turn that is already streaming. The page's last turn is that same
 * turn as last flushed to disk, so its assistant/tool rows yield to the live
 * copy (the live rows are the newer representation) while its user row stays,
 * because the live side cannot supply it.
 *
 * Declines when the live rows are narrower than the page turn: a live turn with
 * fewer assistant rows than the page carries is behind, and dropping the page
 * rows would lose content the live surface does not have yet.
 */
function liveMidTurnOwnedPageIds(
  pageItems: readonly AlignableRow[],
  liveItems: readonly AlignableRow[],
): string[] {
  if (liveItems.some((item) => item.kind === "user")) return [];
  const liveBody = liveItems.filter((item) => item.kind === "assistant" || item.kind === "tool");
  if (liveBody.length === 0) return [];
  const pageAnchors = turnAnchorIndexes(pageItems);
  if (pageAnchors.length === 0) return [];
  const tail = pageItems.slice(pageAnchors[pageAnchors.length - 1]).filter((item) => item.kind !== "user");
  if (tail.length === 0) return [];
  const liveAssistants = liveBody.filter((item) => item.kind === "assistant").length;
  const tailAssistants = tail.filter((item) => item.kind === "assistant").length;
  if (liveAssistants < tailAssistants) return [];
  return tail.map((item) => item.id);
}

export function sameSessionPlaceholderItems<T>(
  target: SessionHydrateIdentity | undefined,
  prev: { meta?: SessionHydrateIdentity; items?: T[] } | undefined,
): T[] | undefined {
  return sameSessionHydrateIdentity(target, prev?.meta) ? prev?.items : undefined;
}
