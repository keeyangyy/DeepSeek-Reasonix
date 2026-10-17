package notify

import (
	"testing"

	"reasonix/internal/config"
	"reasonix/internal/event"
)

func forkApprovalEvent(turnID, id string) event.Event {
	return event.Event{
		Kind:     event.ApprovalRequest,
		TurnID:   turnID,
		ItemID:   id,
		Approval: event.Approval{ID: id, TurnID: turnID},
	}
}

func forkMCPEvent(turnID, id string) event.Event {
	return event.Event{
		Kind:           event.MCPInteractionRequest,
		TurnID:         turnID,
		ItemID:         id,
		MCPInteraction: event.MCPInteraction{ID: id, TurnID: turnID},
	}
}

func forkSink(t *testing.T, inner event.Sink, sender Sender, scope string) *Sink {
	t.Helper()
	sink := NewSink(inner, sender, forkNotifyConfig())
	sink.SetScope(scope)
	return sink
}

// TestSendEventReplayOnlyStaysSilent covers the paths that notify without going
// through Sink.Emit: a replayed prompt must be silent there too.
func TestSendEventReplayOnlyStaysSilent(t *testing.T) {
	sender := &captorSender{}
	SendEvent(sender, forkNotifyConfig(), forkReplay(forkAskEvent("turn-1", "1")))
	if len(sender.messages) != 0 {
		t.Fatalf("notifications = %d, want 0 for a replayed event", len(sender.messages))
	}
}

// TestSinkDedupsRepeatedAskDelivery covers the second half of the bug: even
// without the ReplayOnly flag, the same request identity must only ever raise
// one system notification, while the frontend still sees every delivery.
func TestSinkDedupsRepeatedAskDelivery(t *testing.T) {
	inner := &recordSink{}
	sender := &captorSender{}
	sink := forkSink(t, inner, sender, "tab-a")

	ask := forkAskEvent("turn-1", "1")
	sink.Emit(ask)
	sink.Emit(ask)

	if len(sender.messages) != 1 {
		t.Fatalf("notifications = %d, want 1 for one repeated identity", len(sender.messages))
	}
	if len(inner.events) != 2 {
		t.Fatalf("forwarded events = %d, want 2 (suppression is notification-only)", len(inner.events))
	}
}

// TestSinkNotifiesDistinctAsks proves the dedup never hides a genuinely new
// question: a different request id in the same turn notifies on its own.
func TestSinkNotifiesDistinctAsks(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	sink.Emit(forkAskEvent("turn-1", "1"))
	sink.Emit(forkAskEvent("turn-1", "2"))

	if len(sender.messages) != 2 {
		t.Fatalf("notifications = %d, want 2 for two distinct ask ids", len(sender.messages))
	}
}

// TestSinkNotifiesDistinctTurns covers the round dimension: request ids restart
// per controller, so the same id in a later turn is a new prompt, not a repeat.
func TestSinkNotifiesDistinctTurns(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	sink.Emit(forkAskEvent("turn-1", "1"))
	sink.Emit(forkAskEvent("turn-2", "1"))

	if len(sender.messages) != 2 {
		t.Fatalf("notifications = %d, want 2 for the same id in two turns", len(sender.messages))
	}
}

// TestSinkNotifiesDistinctSessions covers the session dimension: two controllers
// that both hand out request id "1" must each get their own notification.
func TestSinkNotifiesDistinctSessions(t *testing.T) {
	tabA := &captorSender{}
	tabB := &captorSender{}
	sinkA := forkSink(t, &recordSink{}, tabA, "tab-a")
	sinkB := forkSink(t, &recordSink{}, tabB, "tab-b")

	ask := forkAskEvent("turn-1", "1")
	sinkA.Emit(ask)
	sinkB.Emit(ask)

	if len(tabA.messages) != 1 || len(tabB.messages) != 1 {
		t.Fatalf("notifications = %d/%d, want 1/1 for two sessions with the same request id", len(tabA.messages), len(tabB.messages))
	}
}

// TestSinkNotifiesAfterAnswer releases the identity when the user answers, so a
// later request that reuses the id is not mistaken for the answered one.
func TestSinkNotifiesAfterAnswer(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	ask := forkAskEvent("turn-1", "1")
	sink.Emit(ask)
	sink.Emit(event.Event{Kind: event.PromptAnswered, ItemID: "1", Status: event.TurnInProgress})
	sink.Emit(ask)

	if len(sender.messages) != 2 {
		t.Fatalf("notifications = %d, want 2: answer must release the identity", len(sender.messages))
	}
}

// TestSinkReleasesIdentitiesOnTurnDone keeps the dedup set bounded by the
// prompts that are still outstanding.
func TestSinkReleasesIdentitiesOnTurnDone(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	ask := forkAskEvent("turn-1", "1")
	sink.Emit(ask)
	sink.Emit(event.Event{Kind: event.TurnDone, TurnID: "turn-1"})
	sink.Emit(ask)

	// 1 ask + 1 turn-done + 1 ask again = 3.
	if len(sender.messages) != 3 {
		t.Fatalf("notifications = %d, want 3: turn end must release the turn's identities", len(sender.messages))
	}
}

// TestSinkDedupsApprovalDelivery proves the identity applies to tool approvals
// too: a repeated approval (or its replay) notifies once.
func TestSinkDedupsApprovalDelivery(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	approval := forkApprovalEvent("turn-1", "1")
	sink.Emit(approval)
	sink.Emit(approval)
	sink.Emit(forkReplay(approval))

	if len(sender.messages) != 1 {
		t.Fatalf("notifications = %d, want 1 for one repeated approval identity", len(sender.messages))
	}
}

// TestSinkKeepsRequestKindsApart pins the kind dimension: an ask and an approval
// in the same turn can share an id (both counters restart at 1), and each must
// still notify once.
func TestSinkKeepsRequestKindsApart(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	sink.Emit(forkAskEvent("turn-1", "1"))
	sink.Emit(forkApprovalEvent("turn-1", "1"))

	if len(sender.messages) != 2 {
		t.Fatalf("notifications = %d, want 2: the request kind separates identities", len(sender.messages))
	}
}

// TestSinkMCPInteractionHasNoSystemNotification locks today's rule: the message
// table has no MCP-interaction entry, so an elicitation is never mirrored to the
// OS and needs no dedup. If a notification is added for it later, this test
// should be updated together with an identity case for MCP.
func TestSinkMCPInteractionHasNoSystemNotification(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	sink.Emit(forkMCPEvent("turn-1", "1"))

	if len(sender.messages) != 0 {
		t.Fatalf("notifications = %d, want 0: MCP interactions are not mirrored to the OS", len(sender.messages))
	}
}

// TestSinkIdentitylessEventsUnchanged makes sure tenant events that carry no
// request identity (here: turn completions) keep their prior behaviour.
func TestSinkIdentitylessEventsUnchanged(t *testing.T) {
	sender := &captorSender{}
	sink := forkSink(t, &recordSink{}, sender, "tab-a")

	sink.Emit(event.Event{Kind: event.TurnDone, TurnID: "turn-1"})
	sink.Emit(event.Event{Kind: event.TurnDone, TurnID: "turn-2"})

	if len(sender.messages) != 2 {
		t.Fatalf("notifications = %d, want 2: events without an identity are never deduped", len(sender.messages))
	}
}

// TestSinkSuppressedByConfigKeepsIdentityOff asserts an event that the config
// silences does not burn its identity: nothing to suppress, nothing to claim.
func TestSinkSuppressedByConfigKeepsIdentityOff(t *testing.T) {
	sender := &captorSender{}
	sink := NewSink(&recordSink{}, sender, config.NotificationsConfig{Enabled: true, AskRequest: false})
	sink.SetScope("tab-a")

	sink.Emit(forkAskEvent("turn-1", "1"))

	if len(sender.messages) != 0 {
		t.Fatalf("notifications = %d, want 0 while ask notifications are disabled", len(sender.messages))
	}
}
