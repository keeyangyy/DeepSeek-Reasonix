package agent

import "strings"

// capabilityCallPrefixes are the namespaces resolveCall strips before it looks
// up a registry tool. inspect reuses the same table so both actions agree on
// which ids exist.
var capabilityCallPrefixes = []string{"web:", "lsp:", "session:", "memory:"}

// canonicalCapabilityID maps a routable-but-prefixed id onto the catalog id it
// resolves to. Ids the catalog already knows are returned unchanged.
func canonicalCapabilityID(id string) string {
	id = strings.TrimSpace(id)
	for _, prefix := range capabilityCallPrefixes {
		if rest, ok := strings.CutPrefix(id, prefix); ok {
			return "tool:" + strings.TrimSpace(rest)
		}
	}
	return id
}
