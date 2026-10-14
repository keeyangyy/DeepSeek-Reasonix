package agent

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// sessionFileComponent describes a single portable filename component: it must
// not be empty and must not contain Windows/POSIX separators, Windows reserved
// punctuation, NUL, or other control bytes that make the name illegible or
// hostile on any supported platform.
var sessionFileComponent = regexp.MustCompile(`^[^<>:"/\\|?*\x00-\x1f\x7f]+$`)

// maxSessionFileComponentBytes keeps the generated component below the common
// per-component filesystem limit (255 bytes), including the timestamp prefix
// and ".jsonl" suffix, so an overlong model label cannot make session creation
// fail or silently truncate.
const maxSessionFileComponentBytes = 255

// ContinueSessionPath returns where a conversation carried into a rebuilt
// controller (model switch, config change) should keep auto-saving: its existing
// file when it has one, so the continued session stays a single file instead of
// the old one being orphaned as an identical duplicate (#2807). A session with no
// file yet gets a fresh path; "" when persistence is disabled.
func ContinueSessionPath(prevPath, dir, model string) string {
	if prevPath != "" {
		return prevPath
	}
	if dir == "" {
		return ""
	}
	return NewSessionPath(dir, model)
}

// NewSessionPath returns one portable filename below the session directory,
// namespaced by the model so the filename hints at what the conversation was
// with. A model label is an untrusted hint: if it would not form a single valid
// filename component (path separators, "..", reserved punctuation, NUL/control
// bytes, or an overlong result) the path falls back to a timestamped generic
// session name, so the label can never escape the session directory or yield an
// unportable file. dir is typically config.SessionDir().
func NewSessionPath(dir, model string) string {
	safe := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "<", "-", ">", "-", "\"", "-", "|", "-", "?", "-", "*", "-").Replace(model)
	if safe == "" {
		safe = "session"
	}
	stamp := time.Now().UTC().Format("20060102-150405.000000000")
	name := fmt.Sprintf("%s-%s.jsonl", stamp, safe)
	if !sessionFileComponent.MatchString(name) || len(name) > maxSessionFileComponentBytes {
		return filepath.Join(dir, stamp+"-session.jsonl")
	}
	return filepath.Join(dir, name)
}
