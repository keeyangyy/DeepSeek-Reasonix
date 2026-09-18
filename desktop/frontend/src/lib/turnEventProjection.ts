import { asArray } from "./array";
import { app } from "./bridge";
import { recordFrontendDiagnostic } from "./frontendDiagnosticBridge";
import type { TurnEventEnvelope, TurnEventReplayView, WireEvent } from "./types";

type WireHandler = (event: WireEvent) => void;
type ResetHandler = (tabId: string, replay: TurnEventReplayView) => Promise<boolean>;
type ReplayStartHandler = (tabId: string, turnId?: string) => void;

const MAX_REPLAY_PAGES = 32;
const REPAIR_COOLDOWN_MS = 500;

// Diagnostics whitelist tokens reject whitespace; compact an error message into
// a lossy-but-usable token so gap-repair failures stop being silently dropped.
function diagnosticErrorToken(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const token = raw.replace(/[^a-zA-Z0-9._:-]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 64);
  return token || "unknown";
}

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
  private readonly latestByTab = new Map<string, number>();
  private readonly repairCooldownUntilByTab = new Map<string, number>();
  private readonly repairCooldownTimerByTab = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectingReplayByTab = new Set<string>();
  private handler: WireHandler = () => {};
  private resetHandler?: ResetHandler;
  private replayStartHandler?: ReplayStartHandler;

  bind(handler: WireHandler) { this.handler = handler; }
  unbind(handler: WireHandler) { if (this.handler === handler) this.handler = () => {}; }
  bindReset(handler: ResetHandler) { this.resetHandler = handler; }
  unbindReset(handler: ResetHandler) { if (this.resetHandler === handler) this.resetHandler = undefined; }
  bindReplayStart(handler: ReplayStartHandler) { this.replayStartHandler = handler; }
  unbindReplayStart(handler: ReplayStartHandler) { if (this.replayStartHandler === handler) this.replayStartHandler = undefined; }

  release(tabId: string) {
    this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
    this.sequenceByTab.delete(tabId);
    this.gapQueueByTab.delete(tabId);
    this.epochByTab.delete(tabId);
    this.latestByTab.delete(tabId);
    this.projectingReplayByTab.delete(tabId);
    this.pendingRepairByTab.delete(tabId);
    this.repairByTab.delete(tabId);
    const cooldownTimer = this.repairCooldownTimerByTab.get(tabId);
    if (cooldownTimer !== undefined) {
      clearTimeout(cooldownTimer);
      this.repairCooldownTimerByTab.delete(tabId);
    }
    this.repairCooldownUntilByTab.delete(tabId);
  }

  /**
   * The transcript page just replaced/augmented the surface and already owns
   * every durable row up to the last known backend sequence. An in-flight
   * full-turn replay would keep projecting that same content as fresh rows on
   * top of the page (v3 log: co-mounted he-family and a-family duplicates), so
   * the replay is superseded here: its generation is bumped (the paging loop
   * bails at its next checkpoint), the cursor jumps to the latest known
   * sequence, and any gap-queued live rows — whose content the page also
   * carries — are dropped. Live events past the adopted sequence keep flowing
   * normally.
   */
  adoptPage(tabId: string) {
    this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
    const knownLatest = this.latestByTab.get(tabId);
    if (knownLatest !== undefined) {
      const current = this.sequenceByTab.get(tabId) ?? 0;
      this.sequenceByTab.set(tabId, Math.max(current, knownLatest));
    }
    this.gapQueueByTab.delete(tabId);
    this.pendingRepairByTab.delete(tabId);
    // Drop the in-flight repair from the map too: its promise exits via the
    // generation check on its own, but leaving it registered would park every
    // subsequent live event in the gap queue instead of projecting it.
    this.repairByTab.delete(tabId);
  }

  observeRuntime(tabId: string, runtimeEpoch: string | undefined, latest: number, replayAfter: number | undefined, active: boolean, turnId?: string) {
    if (runtimeEpoch && runtimeEpoch !== this.epochByTab.get(tabId)) {
      this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1);
      this.epochByTab.set(tabId, runtimeEpoch);
      this.sequenceByTab.delete(tabId);
      this.gapQueueByTab.delete(tabId);
      this.pendingRepairByTab.delete(tabId);
      this.repairByTab.delete(tabId);
    }
    if (latest > (this.latestByTab.get(tabId) ?? 0)) this.latestByTab.set(tabId, latest);
    let projected = this.sequenceByTab.get(tabId);
    const initializing = projected === undefined;
    if (projected === undefined) {
      // Poison-pill guard: a snapshot taken before the tab's controller (and
      // its turn-event ledger) is bound reports latest=0 with no turn id.
      // Initializing the cursor at 0 here made every later live event demand a
      // full checkpoint-reset replay from sequence 0 (875100f7/e6748f7d: 22+
      // gap-repair failures per open). Stay uninitialized; the next snapshot
      // carrying a real sequence initializes correctly.
      if (latest === 0 && !active) return;
      projected = active ? Math.min(replayAfter ?? latest, latest) : latest;
      this.sequenceByTab.set(tabId, projected);
    }
    if (latest > projected) {
      // A first observation while the turn is active replays the WHOLE turn
      // (ProjectionCursor pins replayAfter to the turn start). The transcript
      // must drop this turn's mounted rows first: applyEvent's delta/append
      // semantics would otherwise double the live buffer and co-mount replayed
      // rows next to their already-settled page duplicates. Incremental gap
      // repairs (non-initializing) never fire this.
      if (initializing && active && replayAfter !== undefined && replayAfter < latest) {
        try {
          this.replayStartHandler?.(tabId, turnId);
        } catch { /* handler failures must not block the replay */ }
      }
      this.requestReplay(tabId, projected, runtimeEpoch);
    }
  }

  acceptLive(tabId: string, event: WireEvent, runtimeEpoch?: string): boolean {
    if (this.projectingReplayByTab.has(tabId)) return true;
    if (typeof event.seq !== "number" || event.seq <= 0) return true;
    const last = this.sequenceByTab.get(tabId) ?? 0;
    if (event.seq <= last) return false;
    if (this.repairByTab.has(tabId) || event.seq > last + 1) {
      const queued = this.gapQueueByTab.get(tabId) ?? [];
      queued.push(event);
      this.gapQueueByTab.set(tabId, queued);
      // Always (re)register the desired replay position: while a repair is
      // in flight this merges into pendingRepair (consumed by its finally),
      // otherwise it starts one. Without the in-flight write a failure
      // cooldown would leave the queued rows with no driver (875100f7).
      this.requestReplay(tabId, last, event.runtimeEpoch ?? runtimeEpoch);
      return false;
    }
    this.sequenceByTab.set(tabId, event.seq);
    return true;
  }

  private requestReplay(tabId: string, afterSeq: number, runtimeEpoch?: string) {
    if (typeof app.TurnEventsForTab !== "function") return;
    if (this.repairByTab.has(tabId)) {
      this.pendingRepairByTab.set(tabId, { afterSeq, runtimeEpoch });
      return;
    }
    // Uninitialized cursor: replay(0) against a compacted ledger would throw
    // straight into the heavyweight checkpoint-reset loop. The queued live
    // rows stay parked; the next real snapshot initializes the cursor and
    // observeRuntime then drains them.
    if (this.sequenceByTab.get(tabId) === undefined && afterSeq === 0) {
      this.pendingRepairByTab.set(tabId, { afterSeq, runtimeEpoch });
      return;
    }
    // Failure cooldown: after a failed repair the tab waits out a short quiet
    // window before retrying. Bursts of live events during the cooldown only
    // refresh the pending request (the pre-existing merge semantics), so a
    // hot turn cannot spawn one repair per event (875100f7: 110 failures).
    const cooldownUntil = this.repairCooldownUntilByTab.get(tabId) ?? 0;
    const now = Date.now();
    if (now < cooldownUntil) {
      this.repairAfterCooldown(tabId, afterSeq, runtimeEpoch);
      return;
    }
    const generation = this.generationByTab.get(tabId) ?? 0;
    const repair = this.replayGap(tabId, afterSeq, runtimeEpoch, generation)
      .catch((error) => {
        this.repairCooldownUntilByTab.set(tabId, Date.now() + REPAIR_COOLDOWN_MS);
        recordFrontendDiagnostic("runtime", "turn-events-gap-repair-failed", {
          afterSeq: this.sequenceByTab.get(tabId) ?? afterSeq,
          error: diagnosticErrorToken(error),
        });
      })
      .finally(() => {
        if (this.repairByTab.get(tabId) !== repair) return;
        this.repairByTab.delete(tabId);
        const pending = this.pendingRepairByTab.get(tabId);
        if (!pending) return;
        this.repairAfterCooldown(tabId, pending.afterSeq, pending.runtimeEpoch);
      });
    this.repairByTab.set(tabId, repair);
  }

  /**
   * Schedule a retry after the failure cooldown elapses. The timer closure
   * carries its own afterSeq/epoch (no shared-state race with later
   * pendingRepair merges — whichever request lands last in the map wins only
   * if a timer is still absent).
   */
  private repairAfterCooldown(tabId: string, afterSeq: number, runtimeEpoch?: string) {
    this.pendingRepairByTab.set(tabId, { afterSeq, runtimeEpoch });
    if (this.repairCooldownTimerByTab.has(tabId)) return;
    const until = this.repairCooldownUntilByTab.get(tabId) ?? 0;
    const wait = Math.max(0, until - Date.now());
    this.repairCooldownTimerByTab.set(
      tabId,
      setTimeout(() => {
        this.repairCooldownTimerByTab.delete(tabId);
        // Consume the freshest merged request, falling back to this timer's
        // own payload when a racing consumer already emptied the map.
        const pending = this.pendingRepairByTab.get(tabId) ?? { afterSeq, runtimeEpoch };
        this.pendingRepairByTab.delete(tabId);
        this.requestReplay(tabId, pending.afterSeq, pending.runtimeEpoch);
      }, wait),
    );
  }

  private async replayGap(tabId: string, afterSeq: number, requestedEpoch: string | undefined, generation: number) {
    // A re-fired repair can carry a stale afterSeq: acceptLive always
    // (re)registers the desired position, and while a repair is in flight that
    // writes pendingRepair at the cursor of its gap event — an older position.
    // The cursor is monotonic and everything below it was already projected,
    // so clamp: projecting from the stale position replays already-mounted
    // rows (observed as mid-turn steer notices doubled at the transcript
    // bottom, with the cursor regressing afterwards).
    let cursor = Math.max(afterSeq, this.sequenceByTab.get(tabId) ?? 0);
    if (cursor > afterSeq) {
      recordFrontendDiagnostic("runtime", "turn-events-replay-clamped", {
        afterSeq: afterSeq,
        resumedAtSeq: cursor,
      });
    }
    for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
      if ((this.generationByTab.get(tabId) ?? 0) !== generation) return;
      const replay = await app.TurnEventsForTab!(tabId, cursor);
      if ((this.generationByTab.get(tabId) ?? 0) !== generation) return;
      // A transiently unavailable backend (controller still starting) is a
      // structured wait, not a repair failure: keep the queued live rows and
      // leave the cursor alone; the next real snapshot or the cooldown timer
      // re-drives the repair.
      if (replay.notReady) return;
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
      if (remaining.length === 0) return;
      this.gapQueueByTab.set(tabId, remaining);
      return;
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
