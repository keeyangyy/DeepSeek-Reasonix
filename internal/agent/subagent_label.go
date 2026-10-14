package agent

import (
	"fmt"
	"strings"
)

// dispatchLabelMaxChars bounds a sub-agent display label. The status strip
// shows several runs on one line, so the label is clipped once here — at the
// dispatch, before it reaches any surface — rather than per-view: a live run, a
// session switch, and a settled run all read the same stored string.
const dispatchLabelMaxChars = 10

// SubagentDispatchLabel builds the single display label for one sub-agent run:
// "<name>: <content>". name is the dispatch tool or profile name ("task",
// "read_only_task", "explore", "research", "expert"), so the reader sees both
// which tool ran and what it was asked to do.
//
// content prefers the caller's short description; when it is empty the prompt
// stands in, so an unlabeled dispatch still names the work instead of repeating
// the tool name. Either source is clipped to dispatchLabelMaxChars so the label
// can never grow into a paragraph — the failure mode this contract exists to
// prevent.
func SubagentDispatchLabel(name, description, prompt string) string {
	name = strings.TrimSpace(name)
	content := strings.TrimSpace(description)
	if content == "" {
		// Only the prompt's first line names the work; the body would be a
		// paragraph and is never a label.
		content = strings.TrimSpace(firstLine(strings.TrimSpace(prompt)))
	}
	content = clipLabel(content)
	if content == "" {
		return name
	}
	if name == "" {
		return content
	}
	return fmt.Sprintf("%s: %s", name, content)
}

// clipLabel trims a label to dispatchLabelMaxChars visible characters,
// appending an ellipsis when it had to cut. Runes, not bytes, so a Chinese
// label is clipped by character.
func clipLabel(label string) string {
	runes := []rune(strings.TrimSpace(label))
	if len(runes) <= dispatchLabelMaxChars {
		return string(runes)
	}
	return string(runes[:dispatchLabelMaxChars]) + "…"
}

// MarkDispatchRunning records a run as running in its sidecar before execution,
// since the status strip reads only the sidecar. Best-effort: a nil store or a
// failed write degrades to no status entry, never to a failed run. statusOnly
// flags the run to skip writing a transcript body when it ends.
func MarkDispatchRunning(store *SubagentStore, run *SubagentRun, statusOnly bool) {
	if run == nil {
		return
	}
	if statusOnly {
		run.StatusOnly = true
	}
	if store != nil && run.Ref != "" {
		_ = store.MarkRunning(run)
	}
}
