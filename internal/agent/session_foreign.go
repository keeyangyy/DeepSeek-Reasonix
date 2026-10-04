package agent

import (
	"encoding/json"
	"os"
)

// foreignMetaFields are sidecar keys only the other line writes. This build's
// BranchMeta has no such field, so loading and re-saving a sidecar drops them -
// hence the listing check reads the raw file rather than the decoded struct.
var foreignMetaFields = []string{"archived", "superseded", "imported_from", "recovery_root_id"}

// IsForeignSession reports whether a session's sidecar was written by the other
// line. It cannot claim this build's own sessions, since every key above is
// unknown here. The converse does not hold: a sidecar without them may still
// belong to the other line, so this filter is conservative, never complete.
func IsForeignSession(sessionPath string) bool {
	path := BranchMetaPath(sessionPath)
	if path == "" {
		return false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil {
		return false
	}
	for _, key := range foreignMetaFields {
		if _, ok := raw[key]; ok {
			return true
		}
	}
	return false
}
