package agent

import "strings"

// capabilityCallPrefixes are the namespaces resolveCall strips before it looks
// up a registry tool. inspect reuses the same table so both actions agree on
// which ids exist.
var capabilityCallPrefixes = []string{"web:", "lsp:", "session:", "memory:"}

// canonicalCapabilityID maps a routable capability id onto the catalog id it
// resolves to. resolveCall accepts more spellings than the catalog lists —
// task:subagent and workflow:foo both dispatch — so inspect must resolve them
// the same way rather than reporting a dispatchable id as unknown.
func canonicalCapabilityID(id string) string {
	id = strings.TrimSpace(id)
	if name, ok := strings.CutPrefix(id, "tool:"); ok {
		return "tool:" + strings.TrimSpace(name)
	}
	if name, ok := strings.CutPrefix(id, "task:"); ok {
		return "tool:" + taskToolName(name)
	}
	if name, ok := strings.CutPrefix(id, "workflow:"); ok {
		return "tool:" + strings.TrimSpace(name)
	}
	for _, prefix := range capabilityCallPrefixes {
		if rest, ok := strings.CutPrefix(id, prefix); ok {
			return "tool:" + strings.TrimSpace(rest)
		}
	}
	return id
}
