package agent

import (
	"reasonix/internal/provider"
	"testing"
)

func TestSessionAddDecisionReceiptMintsUniqueOccurrenceIDs(t *testing.T) {
	s := NewSession("")
	s.Add(provider.Message{Role: provider.RoleUser, Content: "choose a provider"})
	s.Add(provider.Message{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "ask-call", Name: "ask", Arguments: `{}`}}})
	first := &provider.DecisionReceipt{ID: "1", Kind: "ask", Subject: "Choose: A", Outcome: "answered"}
	second := &provider.DecisionReceipt{ID: "1", Kind: "ask", Subject: "Choose: A", Outcome: "answered"}

	s.AddDecisionReceipt(first)
	s.AddDecisionReceipt(second)
	if first.OccurrenceID == "" || second.OccurrenceID == "" {
		t.Fatalf("occurrence IDs must be minted: first=%q second=%q", first.OccurrenceID, second.OccurrenceID)
	}
	if first.OccurrenceID == second.OccurrenceID {
		t.Fatalf("distinct decisions reused occurrence ID %q", first.OccurrenceID)
	}
	messages := s.Snapshot()
	if got := len(messages[1].DecisionReceipts); got != 2 {
		t.Fatalf("stored receipts = %d, want 2", got)
	}
	if messages[1].DecisionReceipts[0].OccurrenceID != first.OccurrenceID || messages[1].DecisionReceipts[1].OccurrenceID != second.OccurrenceID {
		t.Fatalf("stored receipt occurrence IDs = %+v, want the live IDs in order", messages[1].DecisionReceipts)
	}
}

// Session.HasContent
