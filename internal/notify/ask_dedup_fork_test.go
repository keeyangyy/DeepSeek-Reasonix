package notify

import (
	"testing"

	"reasonix/internal/config"
	"reasonix/internal/event"
)

// captorSender records the user-visible notifications a Sink actually sends, so
// a test can assert the count of system notifications for one prompt identity.
type captorSender struct {
	messages []Message
}

func (s *captorSender) Send(m Message) error {
	s.messages = append(s.messages, m)
	return nil
}

func forkNotifyConfig() config.NotificationsConfig {
	return config.NotificationsConfig{
		Enabled:         true,
		TurnDone:        true,
		ApprovalRequest: true,
		AskRequest:      true,
	}
}

func forkAskEvent(turnID, id string) event.Event {
	return event.Event{
		Kind:   event.AskRequest,
		TurnID: turnID,
		ItemID: id,
		Ask:    event.Ask{ID: id, TurnID: turnID},
	}
}

func forkReplay(e event.Event) event.Event {
	e.ReplayOnly = true
	return e
}

// TestSinkReplayDoesNotRenotifyAsk covers the repeated-notification bug: the
// frontend asks the backend to replay a pending prompt more than once during a
// single wait (on load, tab switch, runtime attach, runtime-status refresh), and
// the controller re-emits the same AskRequest with ReplayOnly=true so the
// AskCard can be rebuilt. A replay only restores interface state, so it must
// reach the frontend sink but must not push another system notification.
func TestSinkReplayDoesNotRenotifyAsk(t *testing.T) {
	inner := &recordSink{}
	sender := &captorSender{}
	sink := NewSink(inner, sender, forkNotifyConfig())

	ask := forkAskEvent("turn-1", "1")
	sink.Emit(ask)
	for range 3 {
		sink.Emit(forkReplay(ask))
	}

	if len(sender.messages) != 1 {
		t.Fatalf("notifications = %d, want 1: a replayed ask must not notify again", len(sender.messages))
	}
	if len(inner.events) != 4 {
		t.Fatalf("forwarded events = %d, want 4: replay must still reach the frontend sink", len(inner.events))
	}
}
