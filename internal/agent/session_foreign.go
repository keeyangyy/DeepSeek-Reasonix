package agent

import (
	"encoding/json"
	"os"
)

// foreignMetaFields are sidecar keys only the other line writes. One is enough
// to decide: this build has no such field, so it never produces them.
var foreignMetaFields = []string{"archived", "superseded", "imported_from", "recovery_root_id"}

// ownershipFields are written on every session this build creates: pinning one
// records the scope and workspace root, and the topic pass fills the topic. The
// other line records none of them, so their absence identifies its sessions
// without inventing a marker of our own.
var ownershipFields = []string{"topic_id", "topic_title", "scope", "workspace_root"}

// IsForeignSession reports whether a session belongs to the other line. It errs
// toward keeping sessions: only a sidecar carrying a foreign-only key, or one
// with no trace of this build's own ownership, is claimed.
func IsForeignSession(sessionPath string) bool {
	raw, ok := readRawSidecar(BranchMetaPath(sessionPath))
	if !ok {
		return false
	}
	for _, key := range foreignMetaFields {
		if _, present := raw[key]; present {
			return true
		}
	}
	for _, key := range ownershipFields {
		if _, present := raw[key]; present {
			return false
		}
	}
	return true
}

func readRawSidecar(path string) (map[string]json.RawMessage, bool) {
	if path == "" {
		return nil, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil {
		return nil, false
	}
	return raw, true
}
