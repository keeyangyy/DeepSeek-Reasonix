// Sub-agent run sidecars: the persisted record of one delegated run.
//
// A parent transcript records the dispatching call but keeps no parent/child
// link, and the live progress preview is memory-only. Everything the sub-agent
// panel needs to rebuild after a session switch therefore comes from the run's
// own sidecar: the parent link (parentToolCallId), the settled status, and the
// dispatch's model/effort.

import type { SubagentOutcome } from "./subagentOutcome";

export interface SubagentRunView {
  ref: string;
  /** "<toolCallID>/<childIndex>" for a fleet child, "<toolCallID>" for a task. */
  parentToolCallId?: string;
  kind: string;
  name: string;
  status: string;
  outcome?: string;
  retryable?: boolean;
  errorCode?: string;
  model?: string;
  effort?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SubagentRunBindings {
  /** Sub-agent runs persisted for a tab's current session. */
  ListSubagentsForTab(tabID: string): Promise<SubagentRunView[]>;
}

export function makeMockSubagentRunBindings(): SubagentRunBindings {
  // No run sidecars exist in the browser mock: the panel falls back to whatever
  // the mock transcript itself carries.
  return { async ListSubagentsForTab() { return []; } };
}

/**
 * The tool call that dispatched this run, from its parentToolCallId.
 *
 * A fan-out names its children "<callID>/<index>", so the prefix before the
 * first slash is the call the parent transcript actually recorded. A value with
 * no slash is already that id.
 */
export function parentToolCallIdPrefix(parentToolCallId: string | undefined): string {
  const value = (parentToolCallId ?? "").trim();
  if (!value) return "";
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : value;
}

/** Terminal statuses, mirroring the backend's SubagentStatus vocabulary. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted"]);

export function subagentRunIsRunning(run: SubagentRunView): boolean {
  return !TERMINAL_RUN_STATUSES.has(run.status);
}

/** The outcome card payload for a settled run, or undefined while it runs. */
export function subagentRunOutcome(run: SubagentRunView): SubagentOutcome | undefined {
  switch (run.status) {
    case "completed": return [run.ref, "completed", run.errorCode, run.retryable];
    case "failed": return [run.ref, "failed", run.errorCode, run.retryable];
    case "interrupted": return [run.ref, "cancelled", run.errorCode, run.retryable];
    default: return undefined;
  }
}
