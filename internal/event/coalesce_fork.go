package event

import (
	"reflect"
)

// deltaKey is the identity a buffered burst merges under; any change flushes.
// Streaming text/reasoning bursts key on their kind and source; a tool's output
// burst also keys on the tool id, so two tools streaming at once never merge
// into each other.
type deltaKey struct {
	kind   Kind
	source string
	toolID string
}

// streamDelta reports whether e is a pure streaming delta, with its merge key
// and payload: merging is only safe when no other field carries meaning. The
// zero-probe comparison keeps this true by construction as Event grows fields.
// ToolProgress carrying nothing but one tool's Output merges too — otherwise a
// verbose command's every pipe chunk becomes its own frame (see ec915df21).
func streamDelta(e Event) (deltaKey, string, bool) {
	key := deltaKey{kind: e.Kind, source: e.Source}
	probe := e
	probe.Source = ""
	payload := e.Text
	switch e.Kind {
	case Text, Reasoning:
		probe.Text = ""
	case ToolProgress:
		key.toolID, payload = e.Tool.ID, e.Tool.Output
		probe.Tool.ID, probe.Tool.Output = "", ""
	default:
		return deltaKey{}, "", false
	}
	if payload == "" || (e.Kind == ToolProgress && key.toolID == "") ||
		!reflect.DeepEqual(probe, Event{Kind: e.Kind}) {
		return deltaKey{}, "", false
	}
	return key, payload, true
}

// event rebuilds the event a burst's buffered payload stands for. Progress with
// any field beyond id+output never reaches here (streamDelta rejects it), so
// the rebuilt event keeps every consumer's append semantics unchanged.
func (k deltaKey) event(payload string) Event {
	e := Event{Kind: k.kind, Source: k.source}
	if k.kind == ToolProgress {
		e.Tool = Tool{ID: k.toolID, Output: payload}
	} else {
		e.Text = payload
	}
	return e
}
