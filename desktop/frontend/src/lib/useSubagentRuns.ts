// The status strip's data layer: one source, the persisted run sidecar.
//
// The backend writes a run's sidecar when it starts and rewrites it when it
// ends, so "is anything still running?" has exactly one answer that holds for a
// live session, a background run, and a session switch. Reading only that (and
// never the live event stream, which only some dispatch paths emit) is what
// keeps the strip consistent across all four dispatch tools and agent profiles.

import { useCallback, useEffect, useRef, useState } from "react";

import { app } from "./bridge";
import type { SubagentRunView } from "./types";

/** How often the strip re-reads the sidecar while at least one run is live. */
export const SUBAGENT_RUNS_POLL_MS = 2_500;

/** Run statuses that mean the run is over; the strip drops these at once. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted"]);

/** True while the backend still reports this run as working. */
export function subagentRunIsRunning(run: SubagentRunView): boolean {
  return !TERMINAL_RUN_STATUSES.has(run.status);
}

/**
 * Poll the tab's persisted sub-agent runs.
 *
 * `dispatchCount` is the number of dispatch calls the transcript has seen: when
 * it changes a new sub-agent just started, so the sidecar is re-read
 * immediately instead of waiting out the poll interval. That is what makes a
 * fresh dispatch appear without the user having to switch sessions.
 */
export function useSubagentRuns(tabId: string | undefined, dispatchCount: number): SubagentRunView[] {
  const [runs, setRuns] = useState<SubagentRunView[]>([]);
  const tabRef = useRef(tabId);
  tabRef.current = tabId;

  const load = useCallback(async (id: string | undefined) => {
    if (!id) return;
    try {
      const list = await app.ListSubagentsForTab(id);
      if (tabRef.current !== id) return; // the tab changed while we waited
      setRuns(list);
    } catch {
      // A read failure leaves the last known list in place rather than
      // flickering the strip empty; the next poll retries.
    }
  }, []);

  // A new dispatch re-reads at once, so the run appears the moment the caller
  // sees it in the transcript.
  useEffect(() => {
    void load(tabRef.current);
  }, [dispatchCount, load]);

  // While something runs, keep polling so its end lands without any switch.
  const anyRunning = runs.some(subagentRunIsRunning);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => void load(tabRef.current), SUBAGENT_RUNS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, load]);

  // A tab switch reads once, then hands off to the polling effect above.
  useEffect(() => {
    setRuns([]);
    void load(tabId);
  }, [tabId, load]);

  return runs;
}
