package agent

import (
	"reasonix/internal/provider"
	"reasonix/internal/sessioncontext"
	"strings"
)

// stripFoldIndexes removes the folded-work index section from summary
// messages, leaving every other message untouched.
func stripFoldIndexes(fold []provider.Message) []provider.Message {
	out := make([]provider.Message, len(fold))
	for i, m := range fold {
		if isCompactionSummary(m) {
			prose, _ := splitFoldIndex(m.Content)
			m.Content = strings.TrimRight(prose, "\n")
		}
		out[i] = m
	}
	return out
}

// compactionSnapshotRule is appended only when the fold actually carries a
// host session-context snapshot; the summarizer must not restate it.
const compactionSnapshotRule = "\n\nSkip every message wrapped in <session-context> tags: that " +
	"host-generated snapshot, its section-lengths manifest, and its preamble are re-injected on every " +
	"turn. Do not copy their contents, not even in summary form - restating them would freeze stale state."

// carriesSessionContext reports whether a fold replays a host session-context
// snapshot. Matching on content keeps the check valid after provenance stripping.
func carriesSessionContext(region []provider.Message) bool {
	for _, m := range region {
		if m.Role == provider.RoleUser && sessioncontext.IsContent(m.Content) {
			return true
		}
	}
	return false
}
func (a *Agent) compactionInstructionFor(region []provider.Message, instructions string) string {
	instruction := compactionInstructionWithFocus(instructions)
	if carriesSessionContext(region) {
		instruction += compactionSnapshotRule
	}
	return instruction
}
