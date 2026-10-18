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
// The proxy also carries the action it took: only "call" starts a run, while
// "search", "inspect", "list" and "decline" merely name a target, so counting
// without the action would charge a glance the same as a dispatched agent.

import type { Item } from "./useController";

const SUBAGENT_PROXY_TOOL = "use_capability";
const SUBAGENT_FAN_OUT_TOOLS = new Set(["fleet", "parallel_tasks"]);
const SUBAGENT_DISPATCH_TOOLS = new Set(["task", "read_only_task", ...SUBAGENT_FAN_OUT_TOOLS]);

// Built-in agent profiles that dispatch a sub-agent when proxied.
const SUBAGENT_AGENT_PROFILES = new Set(["explore", "research", "review", "security_review", "security-review"]);

/** The action a proxy call recorded, or undefined when its args say nothing. */
function proxyAction(args?: string): string | undefined {
  if (!args) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const action = (parsed as Record<string, unknown>).action;
    return typeof action === "string" && action.trim() !== "" ? action : undefined;
  } catch {
    // An archived row truncates its args, so the JSON will not parse even though the
    // action is still readable in the surviving prefix. Fall back to reading it there;
    // a truncated call keeps its old count instead of silently dropping out.
    const match = /"action"\s*:\s*"([a-z]+)"/.exec(args);
    return match ? match[1] : undefined;
  }
}

/**
 * The known sub-agent target of this call, or undefined when it is not one.
 *
 * A proxy call carries the action it took, and only "call" starts a run. An action
 * that says otherwise - search, inspect, list, decline - merely names a capability,
 * so charging it as a dispatched agent would inflate the count for a glance. When the
 * action cannot be read at all, the target alone decides, which keeps archived and
 * mid-stream rows counted the way they were before.
 */
export function subagentDispatchName(item: {
  name?: string;
  resolvedName?: string;
  capabilityId?: string;
  args?: string;
}): string | undefined {
  const action = item.name === SUBAGENT_PROXY_TOOL ? proxyAction(item.args) : undefined;
  if (action !== undefined && action !== "call") return undefined;
  if (item.name !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.name)) return item.name;
  if (item.resolvedName !== undefined && SUBAGENT_DISPATCH_TOOLS.has(item.resolvedName)) return item.resolvedName;
  const target = (item.capabilityId ?? "").replace(/^(?:tool|task):/, "");
  if (SUBAGENT_DISPATCH_TOOLS.has(target) || SUBAGENT_AGENT_PROFILES.has(target)) return target;
  return undefined;
}

/** How many sub-agents this transcript row started: one, or a fleet's members. */
export function subagentDispatchCount(item: Item): number {
  if (item.kind !== "tool") return 0;
  const name = subagentDispatchName(item);
  if (name === undefined) return 0;
  return SUBAGENT_FAN_OUT_TOOLS.has(name) ? fanOut(item.args) : 1;
}

/** A fleet / parallel batch names its members in args, directly or behind the proxy. */
function fanOut(args?: string): number {
  if (!args) return 1;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) return 1;
    const record = parsed as Record<string, unknown>;
    const container = typeof record.arguments === "object" && record.arguments !== null
      ? record.arguments as Record<string, unknown>
      : record;
    const tasks = container.tasks;
    return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : 1;
  } catch {
    return 1;
  }
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
