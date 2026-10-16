package sessioncatalog

import (
	"reasonix/internal/agent"
)

// dropForeignSessions removes conversations whose sidecar was written by the
// other line, so this build's catalog only lists what it can safely edit.
func dropForeignSessions(ordered []agent.SessionOrderInfo) []agent.SessionOrderInfo {
	kept := ordered[:0]
	for _, info := range ordered {
		if agent.IsForeignSession(info.Path) {
			continue
		}
		kept = append(kept, info)
	}
	return kept
}
