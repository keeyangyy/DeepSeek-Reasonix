package agent

import (
	"regexp"
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
