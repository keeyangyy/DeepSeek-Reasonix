// Which transcript rows are sub-agent dispatches.
//
// Two callers need different strictness, so this module exposes both:
//  - subagentDispatchName: the known sub-agent targets, for counting what the
//    fold header names ("2 sub-agents"). A wrong count is worse than a missing
//    one, so this is a whitelist and never guesses.
//  - isSubagentDispatchItem: a superset that also accepts any proxied
//    capability call, for deciding when to re-read the run sidecar. There an
//    extra read is free and a missed one delays a run's appearance, so it errs
//    wide.
//
// A dispatch arrives as a direct tool call ("task", "read_only_task", "fleet",
// "parallel_tasks") or through the stable use_capability proxy, where the real
// target sits in resolvedName / capabilityId ("tool:task", "tool:research").

import type { Item } from "./useController";

const SUBAGENT_DISPATCH_TOOLS = new Set(["task", "read_only_task", "parallel_tasks", "fleet"]);

// Built-in agent profiles that dispatch a sub-agent when proxied.
const SUBAGENT_AGENT_PROFILES = new Set(["explore", "research", "review", "security_review", "security-review"]);

/** The known sub-agent target of this call, or undefined when it is not one. */
export function subagentDispatchName(item: {
  name?: string;
  resolvedName?: string;
  capabilityId?: string;
}): string | undefined {
  if (item.name !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.name)) return item.name;
  if (item.resolvedName !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.resolvedName)) return item.resolvedName;
  const target = (item.capabilityId ?? "").replace(/^tool:/, "");
  if (SUBAGENT_DISPATCH_TOOLS.has(target) || SUBAGENT_AGENT_PROFILES.has(target)) return target;
  return undefined;
}

/** True when a transcript row is a known sub-agent dispatch (for counting). */
export function isSubagentDispatch(item: Item): boolean {
  return item.kind === "tool" && subagentDispatchName(item) !== undefined;
}

/** True when a row may have started a run, so the sidecar should be re-read. */
export function isSubagentDispatchItem(item: Item): boolean {
  if (item.kind !== "tool") return false;
  if (subagentDispatchName(item) !== undefined) return true;
  // Any other proxied capability call: the target may be an author-defined
  // agent profile this list cannot know, and a re-read costs nothing.
  return Boolean(item.capabilityId);
}

/**
 * Split a backend label "<tool>: <content>" for display, so the strip can
 * emphasize the tool name over the subject. Only the first separator splits;
 * a label without one is all tool.
 */
export function splitSubagentLabel(label: string): { tool: string; content: string } {
  const sep = label.indexOf(": ");
  if (sep <= 0) return { tool: label, content: "" };
  return { tool: label.slice(0, sep), content: label.slice(sep + 2) };
}
