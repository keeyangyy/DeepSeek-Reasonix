package agent

import (
	"encoding/json"
	"os"
)

// SessionCreatedByLine is stamped into every session this line creates, so a
// listing can tell its own conversations from the other line's by construction
// instead of guessing from sidecar shape (shape turned out not to discriminate).
const SessionCreatedByLine = "reasonix-1x"

// nativeFieldKeys are keys this line stamps whenever it writes a session. A
// sidecar carrying none of them was never opened here, which is what makes the
// unmarked case below safe: an unmarked session with no native trace is the
// other line's, and an unmarked one with a native trace is an older session of
// ours that predates the stamp.
var nativeFieldKeys = []string{"head_id", "listing_revision"}

// foreignMetaFields are sidecar keys only the other line writes. This build's
// BranchMeta has no such field, so loading and re-saving a sidecar drops them -
// hence the listing check reads the raw file rather than the decoded struct.
var foreignMetaFields = []string{"archived", "superseded", "imported_from", "recovery_root_id"}

// IsForeignSession reports whether a session belongs to the other line. It errs
// toward keeping sessions: only a sidecar that positively belongs to the other
// line, or one with no trace of this line at all, is claimed.
func IsForeignSession(sessionPath string) bool {
	raw, ok := readRawSidecar(BranchMetaPath(sessionPath))
	if !ok {
		return false
	}
	if stamped, present := raw["created_by"]; present {
		return string(stamped) != `"`+SessionCreatedByLine+`"`
	}
	for _, key := range foreignMetaFields {
		if _, present := raw[key]; present {
			return true
		}
	}
	for _, key := range nativeFieldKeys {
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
