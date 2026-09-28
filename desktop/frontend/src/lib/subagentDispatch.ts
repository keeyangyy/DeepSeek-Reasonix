// Which tool call is a sub-agent dispatch.
//
// A model that delegates through the stable use_capability proxy reports the
// provider-visible name "use_capability" and puts the real target in
// resolvedName / capabilityId ("tool:fleet"). Matching on `name` alone
// therefore misses exactly the calls that matter, so every sub-agent decision
// (the fold header's count, the panel's inventory) resolves the dispatch
// through this helper instead of testing one field.

import { SUBAGENT_PROGRESS_TOOLS } from "./useController";

// Fan-out containers hold the child calls; the children are the sub-agents. A
// container already counts as one tool call, so counting it again as a
// sub-agent would double-report a single fan-out.
export const SUBAGENT_GROUP_TOOLS = new Set(["parallel_tasks", "fleet"]);

const CAPABILITY_TOOL_PREFIX = "tool:";

/**
 * The sub-agent tool a call dispatches to (task / read_only_task /
 * parallel_tasks / fleet), or undefined when the call is not a dispatch.
 */
export function subagentDispatchName(entry: {
  name?: string;
  resolvedName?: string;
  capabilityId?: string;
}): string | undefined {
  if (entry.name && SUBAGENT_PROGRESS_TOOLS.has(entry.name)) return entry.name;
  if (entry.resolvedName && SUBAGENT_PROGRESS_TOOLS.has(entry.resolvedName)) return entry.resolvedName;
  const capability = entry.capabilityId ?? "";
  if (capability.startsWith(CAPABILITY_TOOL_PREFIX)) {
    const target = capability.slice(CAPABILITY_TOOL_PREFIX.length);
    if (SUBAGENT_PROGRESS_TOOLS.has(target)) return target;
  }
  return undefined;
}
