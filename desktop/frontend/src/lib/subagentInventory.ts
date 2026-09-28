// Sub-agent inventory for the session's sub-agent panel.
//
// The panel answers a question the transcript cannot: which sub-agents ran in
// this session, how they nest (a `fleet` fans out into `task` children), and
// which are still running. The transcript only shows that inside a fold that a
// settled turn closes, so this module projects the flat item list into a tree
// the panel can list independently.
//
// Scope note: `subagentProgress` is an in-memory preview and is never hydrated
// from history (see useController's ToolItem). A hydrated transcript therefore
// yields the calls without their live phase, which the view renders as a
// status-less entry rather than inventing one.

import { SUBAGENT_PROGRESS_TOOLS, isTerminalSubagentPhase, type Item, type SubagentPhase, type SubagentProgress } from "./useController";
import type { SubagentOutcome } from "./subagentOutcome";

type ToolItem = Extract<Item, { kind: "tool" }>;

export interface SubagentEntry {
  /** The dispatching tool call's id (the panel's React key). */
  id: string;
  /** Tool name: task / read_only_task / parallel_tasks / fleet. */
  name: string;
  /** Dispatch subject the transcript uses, when the call carries one. */
  subject: string;
  /** Live phase, or undefined for a call hydrated from history. */
  phase: SubagentPhase | undefined;
  /** Convenience flag: the phase (or tool status) is still non-terminal. */
  running: boolean;
  status: ToolItem["status"];
  /** Model/effort the call was dispatched with, when known. */
  profile: ToolItem["profile"];
  durationMs: number | undefined;
  /** Live preview, absent for a call hydrated from history. */
  progress: SubagentProgress | undefined;
  /** Settled outcome card data, when the backend reported one. */
  outcome: SubagentOutcome | undefined;
  /** Nested calls: a `fleet` holds the `task` children it fanned out. */
  children: SubagentEntry[];
}

/** True when a tool item is a sub-agent dispatch (or a fan-out container). */
export function isSubagentItem(item: Item): item is ToolItem {
  return item.kind === "tool" && SUBAGENT_PROGRESS_TOOLS.has(item.name);
}

function subagentRunning(item: ToolItem): boolean {
  const phase = item.subagentProgress?.phase;
  if (phase) return !isTerminalSubagentPhase(phase);
  // Hydrated (or freshly dispatched) calls carry no phase: fall back to the
  // tool status the row model already uses.
  return item.status === "running";
}

function toEntry(item: ToolItem): SubagentEntry {
  return {
    id: item.id,
    name: item.name,
    subject: item.subject ?? item.summary ?? "",
    phase: item.subagentProgress?.phase,
    running: subagentRunning(item),
    status: item.status,
    profile: item.profile,
    durationMs: item.subagentProgress?.durationMs ?? item.durationMs,
    progress: item.subagentProgress,
    outcome: item.subagentOutcome,
    children: [],
  };
}

/**
 * All sub-agent dispatches of one item list, nested by parentId.
 *
 * Order is the transcript's own (dispatch order), and a call whose parent is
 * missing from the list — a paged history window can drop the parent — stays
 * top-level rather than disappearing: an orphan is still work that ran.
 */
export function buildSubagentForest(items: readonly Item[]): SubagentEntry[] {
  const entries = new Map<string, SubagentEntry>();
  const parentOf = new Map<string, string>();
  const order: string[] = [];
  for (const item of items) {
    if (!isSubagentItem(item)) continue;
    entries.set(item.id, toEntry(item));
    if (item.parentId) parentOf.set(item.id, item.parentId);
    order.push(item.id);
  }
  const roots: SubagentEntry[] = [];
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry) continue;
    const parentId = parentOf.get(id);
    const parent = parentId ? entries.get(parentId) : undefined;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

/** Flattened dispatch count and the number still producing output. */
export function summarizeSubagents(forest: readonly SubagentEntry[]): { total: number; running: number } {
  let total = 0;
  let running = 0;
  const walk = (entries: readonly SubagentEntry[]) => {
    for (const entry of entries) {
      total += 1;
      if (entry.running) running += 1;
      walk(entry.children);
    }
  };
  walk(forest);
  return { total, running };
}
