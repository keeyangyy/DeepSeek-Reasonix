package agent

import (
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// foldShrinkSession builds a session whose recent tail is large enough that the
// recent-tail budget keeps only the last message verbatim.
func foldShrinkSession(head, tail provider.Message) *Session {
	return &Session{Messages: []provider.Message{
		{Role: provider.RoleSystem, Content: "system prompt"},
		head,
		tail,
	}}
}

// TestPlanFoldRegionRejectsOneMessageFoldAfterActiveTurnShrink pins the P3
// follow-up boundary: when the size-based plan succeeds (min=2) but the
// active-turn boundary then shrinks the fold to a single message, the planner
// must report "no fold" rather than hand the summarizer a one-message region.
func TestPlanFoldRegionRejectsOneMessageFoldAfterActiveTurnShrink(t *testing.T) {
	const window = 10_000
	sess := foldShrinkSession(
		provider.Message{Role: provider.RoleUser, Content: "earlier question", CreatedAt: 7},
		provider.Message{Role: provider.RoleAssistant, Content: strings.Repeat("recent tail output ", 400)},
	)
	a := New(&failingSummaryProvider{}, tool.NewRegistry(), sess,
		Options{ContextWindow: window, CompactRatio: 0.85, RecentKeep: 1}, event.Discard)
	// The active turn starts at the second message, which sits inside the
	// size-based fold region, so the boundary shrinks the fold to one message.
	a.activeTurnCreatedAt.Store(7)

	head, start, ok := a.planFoldRegion(sess.Messages, false, false)
	if ok {
		t.Fatalf("fold accepted after active-turn shrink to one message: head=%d start=%d", head, start)
	}
	if start-head >= minCompactMessages {
		t.Fatalf("planner shrank to %d messages (head=%d start=%d), want under %d",
			start-head, head, start, minCompactMessages)
	}
}

// TestPlanFoldRegionKeepsUnshrunkSingleMessageFallback pins the other boundary:
// an unshrunk min=1 fallback (no active turn inside the region) must still be
// accepted, so the conservative guard does not disable the fallback entirely.
func TestPlanFoldRegionKeepsUnshrunkSingleMessageFallback(t *testing.T) {
	const window = 10_000
	// Make the head large enough to exceed the recent-tail budget while the
	// trailing message alone fits it, so planCompaction(min=2) fails and the
	// min=1 fallback selects exactly one message.
	sess := foldShrinkSession(
		provider.Message{Role: provider.RoleUser, Content: strings.Repeat("old context ", 1000)},
		provider.Message{Role: provider.RoleAssistant, Content: strings.Repeat("tail ", 100)},
	)
	a := New(&failingSummaryProvider{}, tool.NewRegistry(), sess,
		Options{ContextWindow: window, CompactRatio: 0.85, RecentKeep: 1}, event.Discard)
	a.activeTurnCreatedAt.Store(999) // no message carries this stamp

	head, start, ok := a.planFoldRegion(sess.Messages, false, false)
	if !ok {
		t.Fatalf("unshrunk single-message fallback was rejected: head=%d start=%d", head, start)
	}
	if start-head != 1 {
		t.Fatalf("fallback fold = %d messages (head=%d start=%d), want exactly 1", start-head, head, start)
	}
}
