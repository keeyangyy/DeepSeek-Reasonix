package event

import (
	"strings"
	"testing"
	"time"
)

// progressOnly returns the ToolProgress events a sink recorded, so a barrier
// event used to flush the buffer does not disturb the assertions.
func progressOnly(inner *coalesceRecordSink) []Event {
	var out []Event
	for _, e := range inner.snapshot() {
		if e.Kind == ToolProgress {
			out = append(out, e)
		}
	}
	return out
}

// barrier flushes whatever the coalescer is holding (any non-delta event does).
func barrier(c Sink) {
	c.Emit(Event{Kind: ToolDispatch, Tool: Tool{ID: "barrier", Name: "bash"}})
}

// A verbose command's output chunks must merge into a few frames instead of one
// frame (and one durable append) per pipe write. This is the fix for
// "a verbose command resets the transcript follower" (upstream ec915df21):
// without it, 3000 output chunks become 3000 frames.
func TestCoalesceMergesToolProgressBurst(t *testing.T) {
	inner := &coalesceRecordSink{}
	c := Coalesce(inner, time.Hour)
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "l1\n"}}) // leading edge
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "l2\n"}})
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "l3\n"}})
	barrier(c)

	got := progressOnly(inner)
	if len(got) != 2 {
		t.Fatalf("got %d progress events, want 2 (leading chunk + merged burst): %+v", len(got), got)
	}
	if got[0].Tool.Output != "l1\n" {
		t.Fatalf("first chunk must forward immediately, got %+v", got[0])
	}
	if got[1].Tool.ID != "t1" || got[1].Tool.Output != "l2\nl3\n" {
		t.Fatalf("progress burst not merged: %+v", got[1])
	}
}

// Two tools streaming at once must never merge into each other: the tool id is
// part of the merge key.
func TestCoalesceSeparatesToolProgressByToolID(t *testing.T) {
	inner := &coalesceRecordSink{}
	c := Coalesce(inner, time.Hour)
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "a"}})
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t2", Output: "b"}})
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "c"}})
	barrier(c)

	got := progressOnly(inner)
	if len(got) < 3 {
		t.Fatalf("a key switch must flush, got %d progress events: %+v", len(got), got)
	}
	for _, e := range got {
		if e.Tool.Output == "ac" || e.Tool.Output == "ca" {
			t.Fatalf("output of two different tools merged: %+v", e)
		}
	}
}

// Progress carrying anything beyond id+output must pass through unmerged (and
// flush the buffer first) so ordering and every consumer's append semantics are
// unchanged.
func TestCoalesceNonPureToolProgressPassesThrough(t *testing.T) {
	inner := &coalesceRecordSink{}
	c := Coalesce(inner, time.Hour)
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "x"}})
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "y"}, TurnID: "turn-1"})
	barrier(c)

	got := progressOnly(inner)
	if len(got) != 2 {
		t.Fatalf("non-pure progress must pass through unmerged, got %d: %+v", len(got), got)
	}
	if got[1].Tool.Output != "y" || got[1].TurnID != "turn-1" {
		t.Fatalf("non-pure progress mangled: %+v", got[1])
	}
}

// Regression: text bursts must keep merging, and an interleaved progress event
// must not swallow or reorder the text stream.
func TestCoalesceToolProgressDoesNotDisturbTextBurst(t *testing.T) {
	inner := &coalesceRecordSink{}
	c := Coalesce(inner, time.Hour)
	c.Emit(Event{Kind: Text, Text: "a"})
	c.Emit(Event{Kind: Text, Text: "b"})
	c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "o"}})
	c.Emit(Event{Kind: Text, Text: "c"})
	barrier(c)

	var texts, progress []string
	for _, e := range inner.snapshot() {
		switch e.Kind {
		case Text:
			texts = append(texts, e.Text)
		case ToolProgress:
			progress = append(progress, e.Tool.Output)
		}
	}
	// The progress event is a key switch, so it flushes "b" before it: text
	// arrives as [a] then [b] then [c], never reordered or dropped.
	if strings.Join(texts, "|") != "a|b|c" {
		t.Fatalf("text stream disturbed by an interleaved progress event: %+v", texts)
	}
	if len(progress) != 1 || progress[0] != "o" {
		t.Fatalf("progress not preserved: %+v", progress)
	}
}

// The frame count for a verbose command must not grow one-per-chunk: emitting
// 3000 chunks inside a single window must collapse to the leading chunk plus a
// merged burst, not ~3000 frames.
func TestCoalesceVerboseCommandFramesStayBounded(t *testing.T) {
	inner := &coalesceRecordSink{}
	c := Coalesce(inner, time.Hour)
	const chunks = 3000
	for i := 0; i < chunks; i++ {
		c.Emit(Event{Kind: ToolProgress, Tool: Tool{ID: "t1", Output: "line\n"}})
	}
	barrier(c)

	got := progressOnly(inner)
	if len(got) >= chunks {
		t.Fatalf("frames not coalesced: got %d events for %d chunks", len(got), chunks)
	}
	// 5 bytes per chunk against a 16 KiB cap: a handful of frames at most.
	if len(got) > 12 {
		t.Fatalf("frames far above the byte-cap expectation: got %d for %d chunks", len(got), chunks)
	}
	total := 0
	for _, e := range got {
		total += strings.Count(e.Tool.Output, "line\n")
	}
	if total != chunks {
		t.Fatalf("merged frames lost output: %d of %d chunks preserved", total, chunks)
	}
}
