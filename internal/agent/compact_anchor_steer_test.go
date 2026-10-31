package agent

import (
	"testing"

	"reasonix/internal/provider"
)

// A mid-turn steer is stored as a user record but renders as a guidance notice,
// not a turn. Counting it made the anchor exceed the number of visible turns, so
// the card fell past the end of the transcript — the "compaction hint jumps to
// the bottom after a restart" symptom.
func TestCompactionAnchorSkipsMidTurnSteer(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "first task"},
		{Role: provider.RoleAssistant, Content: "ok"},
		{Role: provider.RoleUser, Content: midTurnSteerMessage("and please also check logs")},
		{Role: provider.RoleAssistant, Content: "ok"},
		{Role: provider.RoleUser, Content: "second task"},
		{Role: provider.RoleAssistant, Content: "done"},
	}

	if got := countCompactionAnchorUsers(msgs, len(msgs)); got != 2 {
		t.Fatalf("anchor = %d, want 2: a mid-turn steer must not count as a turn", got)
	}
}

// Host-injected context records are not turns either; the projection drops them,
// so counting them shifts the card by the same amount in the other direction.
func TestCompactionAnchorSkipsHostInjectedContext(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "<session-context>\nworkspace snapshot\n</session-context>"},
		{Role: provider.RoleUser, Content: "first task"},
		{Role: provider.RoleAssistant, Content: "ok"},
	}

	if got := countCompactionAnchorUsers(msgs, len(msgs)); got != 1 {
		t.Fatalf("anchor = %d, want 1: a session-context record is not a turn", got)
	}
}

// The covered prefix bounds the count: turns after the fold point still count
// nothing, so a partial compaction anchors where it actually stopped.
func TestCompactionAnchorRespectsCoveredPrefix(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: "first"},
		{Role: provider.RoleAssistant, Content: "ok"},
		{Role: provider.RoleUser, Content: "second"},
		{Role: provider.RoleAssistant, Content: "ok"},
	}

	if got := countCompactionAnchorUsers(msgs, 2); got != 1 {
		t.Fatalf("anchor = %d for covered=2, want 1", got)
	}
	if got := countCompactionAnchorUsers(msgs, len(msgs)); got != 2 {
		t.Fatalf("anchor = %d for the whole transcript, want 2", got)
	}
}
