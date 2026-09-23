// sessionSwitchDiagnostics accumulates session-switch phase timings plus
// transcript dedup/order anomalies, so a local test build can quantify the two
// reported symptoms: slow tab switches and duplicated / misordered rows.
//
// Pure and dependency-free: the hot paths (switchTab, hydrate, the history
// reducer cases) only push small records into bounded ring buffers, so an
// inactive build pays a couple of array pushes per switch — no string joins,
// no scans. `installSessionSwitchDiagnosticsGlobal` exposes the snapshot on
// `window.__reasonixSessionDiagnostics` for a local test build; the snapshot is
// also exportable through the existing export-file bridge.

export type SwitchPhaseRecord = {
  at: number;
  tabId: string;
  phase: string;
  ms: number;
  detail?: string;
};

export type DedupRecord = {
  at: number;
  tabId: string;
  kind: string;
  count: number;
  detail?: string;
};

export type OrderRecord = {
  at: number;
  tabId: string;
  context: string;
  detail?: string;
};

export type SessionSwitchCounters = {
  switches: number;
  dedupDrops: number;
  orderAnomalies: number;
};

export type SessionSwitchSnapshot = {
  counters: SessionSwitchCounters;
  switchPhases: SwitchPhaseRecord[];
  dedupEvents: DedupRecord[];
  orderEvents: OrderRecord[];
};

const MAX_RECORDS = 240;

const switchPhases: SwitchPhaseRecord[] = [];
const dedupEvents: DedupRecord[] = [];
const orderEvents: OrderRecord[] = [];
const counters: SessionSwitchCounters = { switches: 0, dedupDrops: 0, orderAnomalies: 0 };

function push<T>(list: T[], record: T): void {
  list.push(record);
  if (list.length > MAX_RECORDS) list.shift();
}

/** A tab switch began (used to attribute the phases that follow). */
export function noteSwitchStart(): void {
  counters.switches += 1;
}

/** One measured phase of a tab switch, in milliseconds. */
export function noteSwitchPhase(tabId: string, phase: string, ms: number, detail?: string): void {
  push(switchPhases, {
    at: Date.now(),
    tabId,
    phase,
    ms: Math.round(ms * 10) / 10,
    ...(detail ? { detail } : {}),
  });
}

/** Duplicate rows the history merge had to drop (count > 0 only). */
export function noteDedupDrop(tabId: string, kind: string, count: number, detail?: string): void {
  if (count <= 0) return;
  counters.dedupDrops += count;
  push(dedupEvents, { at: Date.now(), tabId, kind, count, ...(detail ? { detail } : {}) });
}

/** An ordering anomaly the merge had to correct (e.g. a compaction card that
 * would have landed after all history rows). */
export function noteOrderAnomaly(tabId: string, context: string, detail?: string): void {
  counters.orderAnomalies += 1;
  push(orderEvents, { at: Date.now(), tabId, context, ...(detail ? { detail } : {}) });
}

export function sessionSwitchSnapshot(): SessionSwitchSnapshot {
  return {
    counters: { ...counters },
    switchPhases: switchPhases.map((record) => ({ ...record })),
    dedupEvents: dedupEvents.map((record) => ({ ...record })),
    orderEvents: orderEvents.map((record) => ({ ...record })),
  };
}

export function resetSessionSwitchDiagnostics(): void {
  switchPhases.length = 0;
  dedupEvents.length = 0;
  orderEvents.length = 0;
  counters.switches = 0;
  counters.dedupDrops = 0;
  counters.orderAnomalies = 0;
}

/** Slowest switch phases plus the counters — a compact human-readable digest. */
export function sessionSwitchSummary(): string {
  const snapshot = sessionSwitchSnapshot();
  const slowest = snapshot.switchPhases
    .slice()
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 8);
  return JSON.stringify({ counters: snapshot.counters, slowest }, null, 2);
}

type DiagnosticsGlobal = {
  snapshot: typeof sessionSwitchSnapshot;
  summary: typeof sessionSwitchSummary;
  reset: typeof resetSessionSwitchDiagnostics;
};

declare global {
  interface Window {
    __reasonixSessionDiagnostics?: DiagnosticsGlobal;
  }
}

/** Expose the accumulator on `window` (local test builds). No-op without a window. */
export function installSessionSwitchDiagnosticsGlobal(target?: Window): void {
  const host = target ?? (typeof window !== "undefined" ? window : undefined);
  if (!host) return;
  host.__reasonixSessionDiagnostics = {
    snapshot: sessionSwitchSnapshot,
    summary: sessionSwitchSummary,
    reset: resetSessionSwitchDiagnostics,
  };
}
