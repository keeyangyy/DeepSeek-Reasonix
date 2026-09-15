import { asArray } from "./array";
import { app } from "./bridge";
import { recordFrontendDiagnostic } from "./frontendDiagnosticBridge";
import type { TurnEventEnvelope, TurnEventReplayView, WireEvent } from "./types";

type WireHandler = (event: WireEvent) => void;
type ResetHandler = (tabId: string, replay: TurnEventReplayView) => Promise<boolean>;
type ReplaySeedHandler = (tabId: string, fromSeq: number) => void;
type ReplayDoneHandler = (tabId: string) => void;

const MAX_REPLAY_PAGES = 32;

// A re-delivered live event is indistinguishable from a fresh one when it
// carries no seq (the backend omits seq on some compatibility paths), so the
// projectors's sequence guard cannot see it and its delta is applied twice,
// rendering the same reasoning/answer text a second time. Content deltas are
// incremental, so an identical kind+body reappearing inside this window is a
// re-delivery rather than new content.
const LIVE_DEDUP_WINDOW_MS = 50;

// TurnEventProjector is the per-tab ordered projection boundary. While a gap or
// checkpoint reset is being repaired, live events are held and applied only
// after the durable page and transcript prefix agree.
export class TurnEventProjector {
  private readonly sequenceByTab = new Map<string, number>();
  private readonly repairByTab = new Map<string, Promise<void>>();
  private readonly pendingRepairByTab = new Map<string, { afterSeq: number; runtimeEpoch?: string }>();
  private readonly gapQueueByTab = new Map<string, WireEvent[]>();
  private readonly epochByTab = new Map<string, string>();
  private readonly generationByTab = new Map<string, number>();
  private readonly projectingReplayByTab = new Set<string>();
  // Re-delivery guard for seq-less live deltas: kind+body → the time it was
  // last accepted. See LIVE_DEDUP_WINDOW_MS.
  private readonly liveFingerprintByTab = new Map<string, Map<string, number>>();
  private liveDedupHits = 0;
  private replayDoneHandler?: ReplayDoneHandler;
  private handler: WireHandler = () => {};
  private resetHandler?: ResetHandler;
  private replayStartHandler?: ReplaySeedHandler;

  bind(handler: WireHandler) { this.handler = handler; }
  unbind(handler: WireHandler) { if (this.handler === handler) this.handler = () => {}; }
  bindReset(handler: ResetHandler) { this.resetHandler = handler; }
  unbindReset(handler: ResetHandler) { if (this.resetHandler === handler) this.resetHandler = undefined; }
  // Notified once before a gap replay projects its first event, so the reducer
  // can rewind the active turn's segment allocation and let the replay rebuild
  // that turn in place instead of appending a second copy of it.
  bindReplayStart(handler: ReplaySeedHandler) { this.replayStartHandler = handler; }
  unbindReplayStart(handler: ReplaySeedHandler) { if (this.replayStartHandler === handler) this.replayStartHandler = undefined; }
  bindReplayDone(handler: ReplayDoneHandler) { this.replayDoneHandler = handler; }
  unbindReplayDone(handler: ReplayDoneHandler) { if (this.replayDoneHandler === handler) this.replayDoneHandler = undefined; }

  release(tabId: string) {
    this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
    this.sequenceByTab.delete(tabId);
    this.gapQueueByTab.delete(tabId);
    this.epochByTab.delete(tabId);
    this.projectingReplayByTab.delete(tabId);
    this.pendingRepairByTab.delete(tabId);
    this.repairByTab.delete(tabId);
  }

  /**
   * Forgets the projection cursor for a tab whose transcript was just cleared.
   *
   * The cursor lives outside the reducer, so a `reset` that empties the
   * transcript leaves it pointing at events that are no longer on screen. The
   * next observeRuntime then sees a known cursor, treats the runtime snapshot as
   * a gap backfill, and only projects the events after it: everything the
   * dropped prefix held — the in-flight turn's reasoning and answer — is gone
   * for good. Dropping the cursor here makes that next observation re-seed from
   * the turn's start and replay the whole turn, which rebuilds the cleared
   * prefix instead of skipping it.
   *
   * Only the cursor is dropped: the generation fence, the epoch and any error
   * bookkeeping stay, so an in-flight replay is still cancelled by its
   * generation rather than resurrected.
   */
  resetCursor(tabId: string, opts: { dropEpoch?: boolean } = {}) {
    this.sequenceByTab.delete(tabId);
    this.gapQueueByTab.delete(tabId);
    this.pendingRepairByTab.delete(tabId);
    if (opts.dropEpoch) this.epochByTab.delete(tabId);
  }

  observeRuntime(tabId: string, runtimeEpoch: string | undefined, latest: number, replayAfter: number | undefined, active: boolean) {
    if (runtimeEpoch && runtimeEpoch !== this.epochByTab.get(tabId)) {
      this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
      this.epochByTab.set(tabId, runtimeEpoch);
      this.sequenceByTab.delete(tabId);
      this.gapQueueByTab.delete(tabId);
      this.pendingRepairByTab.delete(tabId);
      this.repairByTab.delete(tabId);
    }
    let projected = this.sequenceByTab.get(tabId);
    const freshSeed = projected === undefined;
    if (projected === undefined) {
      projected = active ? Math.min(replayAfter ?? latest, latest) : latest;
      this.sequenceByTab.set(tabId, projected);
    }
    // Rewind the active turn's segment allocation whenever the replay will
    // re-project the turn's FIRST event: either a fresh seed that lands on
    // (or before) the turn start, or a gap whose cursor still predates the
    // turn start. In both cases the turn's rows are already on screen, so the
    // replay must rebuild them in place, not append a parallel copy. A gap
    // backfill whose cursor already sits at-or-past the turn start re-projects
    // only the still-missing tail; rewinding there would strand the segments
    // below it, so that case is deliberately left alone.
    const rewindTurn =
      active &&
      replayAfter !== undefined &&
      latest > projected &&
      projected <= replayAfter &&
      (freshSeed || projected < replayAfter);
    if (rewindTurn) {
      recordFrontendDiagnostic("runtime", "replay.seed", { sequence: projected, intent: latest });
      this.replayStartHandler?.(tabId, projected);
    }
    if (latest > projected) this.requestReplay(tabId, projected, runtimeEpoch);
  }

  acceptLive(tabId: string, event: WireEvent, runtimeEpoch?: string): boolean {
    if (this.projectingReplayByTab.has(tabId)) return true;
    if (typeof event.seq !== "number" || event.seq <= 0) {
      // Nothing to compare against the cursor, so fall back to the re-delivery
      // guard: a doubled seq-less delta would otherwise be applied twice and
      // render the same reasoning/answer text a second time.
      if (this.isDuplicateLiveEvent(tabId, event)) {
        this.liveDedupHits += 1;
        recordFrontendDiagnostic("runtime", "live.dedup", { action: event.kind, sequence: this.liveDedupHits });
        return false;
      }
      return true;
    }
    const last = this.sequenceByTab.get(tabId) ?? 0;
    if (event.seq <= last) return false;
    if (this.repairByTab.has(tabId) || event.seq > last + 1) {
      const queued = this.gapQueueByTab.get(tabId) ?? [];
      queued.push(event);
      this.gapQueueByTab.set(tabId, queued);
      if (!this.repairByTab.has(tabId)) {
        this.requestReplay(tabId, last, event.runtimeEpoch ?? runtimeEpoch);
      }
      return false;
    }
    this.sequenceByTab.set(tabId, event.seq);
    return true;
  }

  /** True when this seq-less delta repeats one accepted moments ago. */
  private isDuplicateLiveEvent(tabId: string, event: WireEvent): boolean {
    if (event.kind !== "text" && event.kind !== "reasoning") return false;
    const body = event.text ?? event.reasoning ?? "";
    if (body === "") return false;
    const now = Date.now();
    let seen = this.liveFingerprintByTab.get(tabId);
    if (!seen) {
      seen = new Map<string, number>();
      this.liveFingerprintByTab.set(tabId, seen);
    }
    for (const [key, at] of seen) {
      if (now - at > LIVE_DEDUP_WINDOW_MS) seen.delete(key);
    }
    const fingerprint = `${event.kind}|${body}`;
    if (seen.has(fingerprint)) return true;
    seen.set(fingerprint, now);
    return false;
  }

  /**
   * Resolves once any in-flight replay / gap repair for the tab has settled, or
   * once a fresh one it triggered has too. A no-op when nothing is running.
   *
   * A hydrate that merges the history page races the replay: the page arrives
   * while the replay is still re-projecting the active turn, so the live rows
   * the merge sees are a partial rebuild. The apply-mode decision and the
   * page-tail alignment then compare against that half-built turn and lay the
   * whole page down beside it. Waiting for the replay to settle first makes
   * both decisions observe the complete turn.
   */
  async waitForIdle(tabId: string): Promise<void> {
    // A settled repair can chain a follow-up repair from its finally block, so
    // keep draining until the tab has no repair left.
    for (let guard = 0; guard < MAX_REPLAY_PAGES; guard += 1) {
      const repair = this.repairByTab.get(tabId);
      if (!repair) return;
      try {
        await repair;
      } catch {
        // gap-repair-failed is recorded in requestReplay; the hydrate proceeds
        // against whatever did project rather than hanging here.
        return;
      }
    }
  }

  private requestReplay(tabId: string, afterSeq: number, runtimeEpoch?: string) {
    if (typeof app.TurnEventsForTab !== "function") return;
    if (this.repairByTab.has(tabId)) {
      this.pendingRepairByTab.set(tabId, { afterSeq, runtimeEpoch });
      return;
    }
    const generation = this.generationByTab.get(tabId) ?? 0;
    const repair = this.replayGap(tabId, afterSeq, runtimeEpoch, generation)
      .catch((error) => recordFrontendDiagnostic("runtime", "turn-events-gap-repair-failed", {
        afterSeq: this.sequenceByTab.get(tabId) ?? afterSeq,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        if (this.repairByTab.get(tabId) !== repair) return;
        this.repairByTab.delete(tabId);
        const pending = this.pendingRepairByTab.get(tabId);
        if (!pending) return;
        this.pendingRepairByTab.delete(tabId);
        this.requestReplay(tabId, pending.afterSeq, pending.runtimeEpoch);
      });
    this.repairByTab.set(tabId, repair);
  }

  private async replayGap(tabId: string, afterSeq: number, requestedEpoch: string | undefined, generation: number) {
    let cursor = afterSeq;
    for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
      if ((this.generationByTab.get(tabId) ?? 0) !== generation) return;
      const replay = await app.TurnEventsForTab!(tabId, cursor);
      if ((this.generationByTab.get(tabId) ?? 0) !== generation) return;
      const currentEpoch = this.epochByTab.get(tabId);
      if ((requestedEpoch && currentEpoch && requestedEpoch !== currentEpoch) ||
        (replay.runtimeEpoch && currentEpoch && replay.runtimeEpoch !== currentEpoch)) {
        return;
      }

      if (replay.resetRequired) {
        if (!this.resetHandler || !(await this.resetHandler(tabId, replay))) {
          throw new Error("turn event checkpoint reset could not hydrate the transcript");
        }
        if ((this.generationByTab.get(tabId) ?? 0) !== generation) return;
        cursor = Math.max(0, replay.floorSeq - 1);
        this.sequenceByTab.set(tabId, cursor);
      }

      const envelopes = asArray(replay.events).slice().sort((a, b) => a.seq - b.seq);
      // A replay is re-projecting durable events the surface may already hold.
      for (const envelope of envelopes) {
        if (envelope.seq <= cursor) continue;
        if (envelope.seq !== cursor + 1) throw new Error(`turn event replay gap after ${cursor}`);
        this.projectEnvelope(tabId, envelope, requestedEpoch);
        cursor = envelope.seq;
        this.sequenceByTab.set(tabId, cursor);
      }
      if (replay.hasMore) {
        const next = replay.nextAfterSeq;
        if (next !== cursor) throw new Error(`turn event replay cursor mismatch: projected ${cursor}, backend ${next}`);
        if (envelopes.length === 0) throw new Error("turn event replay made no progress");
        continue;
      }

      const pending = asArray(this.gapQueueByTab.get(tabId)).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      this.gapQueueByTab.delete(tabId);
      const remaining: WireEvent[] = [];
      for (const live of pending) {
        if (typeof live.seq !== "number" || live.seq <= 0) {
          this.handler(live);
          continue;
        }
        if (live.seq <= cursor) continue;
        if (live.seq !== cursor + 1) {
          remaining.push(live);
          continue;
        }
        this.handler(live);
        cursor = live.seq;
        this.sequenceByTab.set(tabId, cursor);
      }
      if (remaining.length === 0) {
        this.replayDoneHandler?.(tabId);
        return;
      }
      this.gapQueueByTab.set(tabId, remaining);
    }
    recordFrontendDiagnostic("runtime", "turn-events-gap-repair-incomplete", {
      afterSeq: this.sequenceByTab.get(tabId) ?? cursor,
    });
  }

  private projectEnvelope(tabId: string, envelope: TurnEventEnvelope, runtimeEpoch?: string) {
    const durable = envelope?.event;
    if (!durable || typeof envelope.seq !== "number") return;
    this.projectingReplayByTab.add(tabId);
    try {
      this.handler({
        ...durable,
        turnId: envelope.turnId || durable.turnId,
        seq: envelope.seq,
        status: (envelope.status || durable.status) as WireEvent["status"],
        tabId,
        runtimeEpoch: envelope.runtimeEpoch ?? runtimeEpoch,
      });
    } finally {
      this.projectingReplayByTab.delete(tabId);
    }
  }
}
