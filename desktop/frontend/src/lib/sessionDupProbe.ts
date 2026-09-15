// TEST-LINE ONLY PROBE — never flows back to main-v2.
// One-shot diagnostics for the "switching between sessions duplicates the
// in-flight turn" bug: every merge, page fetch, event-anomaly, and the Go
// emit-side mirror are recorded into the existing frontend diagnostics ring
// (16k events, exported from the diagnostics settings page).
//
// The probe must stay side-effect free: no state mutation, no timing logic
// beyond lightweight dedupe keys, everything funnels into
// frontendDiagnostics.record (which no-ops unless a recording session is
// active, so the cost in production is one cheap status check per call).

import { frontendDiagnostics } from "./frontendDiagnostics";

const PROBE = "session-dup";
const PREFIX = 24;

type ProbeRow = {
  id?: string;
  kind?: string;
  text?: string;
  reasoning?: string;
  streaming?: boolean;
  status?: string;
};

function clip(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  return s.length > PREFIX ? `${s.slice(0, PREFIX)}…` : s;
}

/** Compact one-line description of a row, for compact log payloads. */
export function describeRow(row: ProbeRow): string {
  const flags = [
    row.streaming ? "S" : "",
    row.status && row.status !== "done" ? `st:${row.status}` : "",
  ].filter(Boolean);
  const body = row.kind === "tool" ? row.id : clip(row.text);
  return `${row.kind ?? "?"}|${row.id ?? "?"}|${body}${flags.length ? ` [${flags.join(",")}]` : ""}`;
}

/** Describe up to `cap` rows (head + tail when truncated) with counts. */
export function describeRows(rows: readonly ProbeRow[], cap = 48): string {
  if (rows.length === 0) return "(none)";
  if (rows.length <= cap) return rows.map(describeRow).join("\n");
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return [
    ...rows.slice(0, head).map(describeRow),
    `… ${rows.length - cap} more …`,
    ...rows.slice(rows.length - tail).map(describeRow),
  ].join("\n");
}

/**
 * Entry ids shared across the page and live sides: history rows carry
 * `he:<entry>` (or `he:<entry>:tc<n>`) ids while local live items use
 * allocator ids, so duplicates of the same backend entry are matched on the
 * parsed entry, never on the raw id.
 */
function entryOf(id: string | undefined): string | null {
  if (!id || !id.startsWith("he:")) return null;
  return id.slice(3).replace(/:tc\d+$/, "");
}

type DupPair = { a: string; b: string; kind: string; by: "entry" | "id" | "text" };

/**
 * Find rows that appear on BOTH sides: same kind with a shared entry/id, or
 * (for assistant rows) identical text — the cases the merge dedupe must
 * resolve. Capped so a pathological list cannot overflow the event.
 */
export function findDuplicatePairs(pageRows: readonly ProbeRow[], liveRows: readonly ProbeRow[], cap = 8): DupPair[] {
  const out: DupPair[] = [];
  for (const p of pageRows) {
    if (out.length >= cap) break;
    const pEntry = entryOf(p.id);
    const pText = (p.kind === "assistant" ? p.text ?? "" : "").trim();
    for (const l of liveRows) {
      if (out.length >= cap) break;
      if (l.kind !== p.kind || !l.id || !p.id) continue;
      const lEntry = entryOf(l.id);
      if ((pEntry !== null && pEntry === lEntry) || p.id === l.id) {
        out.push({ a: p.id, b: l.id, kind: p.kind ?? "?", by: pEntry !== null && pEntry === lEntry ? "entry" : "id" });
        break;
      }
      if (pText !== "" && pText === (l.text ?? "").trim() && l.kind === "assistant") {
        out.push({ a: p.id, b: l.id, kind: "assistant", by: "text" });
        break;
      }
    }
  }
  return out;
}

function record(tag: string, fields: Record<string, string | number | boolean | null>): void {
  try {
    frontendDiagnostics.record(PROBE, tag, fields);
  } catch {
    // Probe must never break the app under test.
  }
}

// ── merge: every history page meeting the live surface ──────────────────────

export function probeMerge(input: {
  tabId: string;
  kind: string;
  reason: string;
  applyMode: string;
  pageRows: readonly ProbeRow[];
  liveRows: readonly ProbeRow[];
  keptCount: number;
  removedLive: readonly string[];
  totalTurns: number;
  pageStartTurn: number;
  liveStartTurn: number;
}): void {
  const pairs = findDuplicatePairs(input.pageRows, input.liveRows);
  record("merge", {
    tabId: input.tabId,
    kind: input.kind,
    reason: input.reason,
    applyMode: input.applyMode,
    pageCount: input.pageRows.length,
    liveCount: input.liveRows.length,
    keptCount: input.keptCount,
    removedLive: input.removedLive.join(",") || "(none)",
    totalTurns: input.totalTurns,
    pageStartTurn: input.pageStartTurn,
    liveStartTurn: input.liveStartTurn,
    dupPairs: pairs.length ? pairs.map((pair) => `${pair.a}~${pair.b}(${pair.kind}/${pair.by})`).join("; ") : "(none)",
    pageRows: describeRows(input.pageRows),
    liveRows: describeRows(input.liveRows),
  });
}

// ── page fetch: every loadLatest/loadOlder result ───────────────────────────

export function probePageFetch(input: {
  tabId: string;
  op: "latest" | "older";
  residentHit: boolean;
  source: string;
  entries: number;
  startTurn: number;
  endTurn: number;
  totalTurns: number;
  revisionKnown: boolean;
  hasOlder: boolean;
  nextCursor: string;
}): void {
  record("page-fetch", {
    tabId: input.tabId,
    op: input.op,
    residentHit: input.residentHit,
    source: input.source,
    entries: input.entries,
    startTurn: input.startTurn,
    endTurn: input.endTurn,
    totalTurns: input.totalTurns,
    revisionKnown: input.revisionKnown,
    hasOlder: input.hasOlder,
    cursorLen: input.nextCursor.length,
  });
}

// ── events: an emit-side mirror arriving from the Go layer ──────────────────

const lastGoMirrorAt = new Map<string, { at: number; count: number }>();

export function probeGoAgentEvent(tabId: string, kind: string): void {
  const now = Date.now();
  const prev = lastGoMirrorAt.get(tabId);
  if (!prev || now - prev.at > 5_000) {
    lastGoMirrorAt.set(tabId, { at: now, count: 1 });
    return;
  }
  prev.count += 1;
  // One burst per window: how many agent events the Go side emitted in 5s.
  record("go-agent-event-burst", { tabId, kind, per5s: prev.count });
}

// ── events: frontend-side repeat detection per (tab, event kind, target) ───

const lastEvent = new Map<string, { at: number; target: string; count: number }>();

/**
 * Call for every applied wire event. Records only when the same tab+kinder
 * target repeats within 5s — normal streaming appends are free.
 */
export function probeEventApplied(tabId: string, kind: string, target: string): void {
  const key = `${tabId}:${kind}`;
  const now = Date.now();
  const prev = lastEvent.get(key);
  if (!prev || now - prev.at > 5_000 || prev.target !== target) {
    lastEvent.set(key, { at: now, target, count: 1 });
    return;
  }
  prev.count += 1;
  record("event-repeat", { tabId, kind, target: clip(target), repeats: prev.count });
}

// ── install: subscribe to the Go emit-side mirror channel ───────────────────

/**
 * Subscribe to the "probe:agent-event" mirror emitted by the Go layer for
 * every agent event forwarded to the webview. In a bare browser (no Wails
 * runtime) this is a no-op. Call once at app startup.
 */
export function installSessionDupProbe(): void {
  if (typeof window === "undefined") return;
  const runtime = window.runtime;
  if (!runtime?.EventsOn) return;
  try {
    runtime.EventsOn("probe:agent-event", (payload) => {
      const p = payload as { tabId?: string; kind?: string } | undefined;
      probeGoAgentEvent(String(p?.tabId ?? "∅"), String(p?.kind ?? "wire"));
    });
  } catch {
    // Probe must never break the app under test.
  }
}

// ── rebuild detection: surface lost its items while a turn was active ──────

export function probeSurfaceRebuild(input: { tabId: string; reason: string; running: boolean; turnActive: boolean; itemsLen: number }): void {
  record("surface-rebuild", {
    tabId: input.tabId,
    reason: input.reason,
    running: input.running,
    turnActive: input.turnActive,
    itemsLen: input.itemsLen,
  });
}
