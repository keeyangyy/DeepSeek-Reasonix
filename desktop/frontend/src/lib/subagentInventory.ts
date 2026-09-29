// Which transcript rows may have started a sub-agent.
//
// The status strip takes its labels from the persisted run sidecar (see
// useSubagentRuns), not from the transcript, so this module answers only one
// question: did a dispatch just happen? A change tells the strip to re-read the
// sidecar now instead of waiting out its poll.
//
// A dispatch arrives as a direct tool call ("task", "read_only_task", "fleet",
// "parallel_tasks") or through the stable use_capability proxy, where the real
// target sits in resolvedName / capabilityId ("tool:task", "tool:research" for
// an agent profile). Every proxied call counts: a capability id cannot be
// statically classified as "spawns a sub-agent" (a profile is any name the user
// authored), and a re-read is cheap enough that over-triggering costs nothing
// while under-triggering would delay a run's appearance.

import type { Item } from "./useController";

const SUBAGENT_DISPATCH_TOOLS = new Set(["task", "read_only_task", "parallel_tasks", "fleet"]);

/** The sub-agent tool this call dispatches to, when the transcript names one. */
export function subagentDispatchName(item: {
  name?: string;
  resolvedName?: string;
  capabilityId?: string;
}): string | undefined {
  if (item.name !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.name)) return item.name;
  if (item.resolvedName !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.resolvedName)) return item.resolvedName;
  const target = (item.capabilityId ?? "").replace(/^tool:/, "");
  return SUBAGENT_DISPATCH_TOOLS.has(target) ? target : undefined;
}

/** True when a transcript row may have started a sub-agent run. */
export function isSubagentDispatchItem(item: Item): boolean {
  if (item.kind !== "tool") return false;
  if (subagentDispatchName(item) !== undefined) return true;
  // A proxied capability call: the target may be an agent profile, so re-read.
  return Boolean(item.capabilityId);
}
