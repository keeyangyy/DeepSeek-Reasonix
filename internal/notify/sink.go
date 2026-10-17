package notify

import (
	"sync"

	"reasonix/internal/config"
	"reasonix/internal/event"
)

// Message is the user-visible payload sent to the platform notifier.
type Message struct {
	Title string
	Body  string
}

// Sender delivers a notification without taking ownership of event routing.
type Sender interface {
	Send(Message) error
}

// Sink forwards every event to inner and mirrors configured attention events to sender.
type Sink struct {
	event.AuditForwarder
	inner  event.Sink
	sender Sender
	cfg    config.NotificationsConfig

	// scope names the session/tab this sink notifies for. Ask and approval ids
	// are only unique inside one controller, so the scope keeps two sessions
	// from collapsing into the same request identity.
	scopeMu sync.RWMutex
	scope   string
	// dedup suppresses repeats of a request identity this sink already
	// announced; see dedup_fork.go.
	dedup promptDedup
}

// NewSink wraps an existing event sink with best-effort notification delivery.
func NewSink(inner event.Sink, sender Sender, cfg config.NotificationsConfig) *Sink {
	return &Sink{AuditForwarder: event.AuditForwarder{Inner: inner}, inner: inner, sender: sender, cfg: cfg}
}

// SetScope names the session/tab this sink notifies for. It is set once while the
// sink is being wired to its controller, before any event is routed.
func (s *Sink) SetScope(id string) {
	if s == nil {
		return
	}
	s.scopeMu.Lock()
	s.scope = id
	s.scopeMu.Unlock()
}

func (s *Sink) sessionScope() string {
	if s == nil {
		return ""
	}
	s.scopeMu.RLock()
	defer s.scopeMu.RUnlock()
	return s.scope
}

// Emit preserves the underlying event stream before attempting notification side effects.
func (s *Sink) Emit(e event.Event) {
	if s.inner != nil {
		s.inner.Emit(e)
	}
	s.send(e)
}

// send applies the notification rules for one event: a replay re-emission stays
// silent (the same rule SendEvent applies to paths outside Sink) and a request
// identity this sink already announced is not announced twice. An identity is
// only claimed for an event that would really notify, so an event suppressed by
// the per-event config does not burn its identity.
func (s *Sink) send(e event.Event) {
	if !s.cfg.Enabled || s.sender == nil || e.ReplayOnly {
		return
	}
	s.forgetResolved(e)
	msg, ok := message(s.cfg, e)
	if !ok {
		return
	}
	if key, ok := requestIdentity(e, s.sessionScope()); ok && !s.dedup.claim(key) {
		return
	}
	_ = s.sender.Send(msg)
}

// forgetResolved releases the identities of a prompt the user has answered and
// of every prompt in a finished turn, so the dedup set stays bounded by the
// prompts that are really outstanding and a later request is never mistaken for
// a duplicate.
func (s *Sink) forgetResolved(e event.Event) {
	switch e.Kind {
	case event.PromptAnswered:
		answered := e.ItemID
		if answered == "" {
			return
		}
		s.dedup.forget(func(k promptDedupKey) bool { return k.itemID == answered })
	case event.TurnDone:
		turn := e.TurnID
		if turn == "" {
			return
		}
		s.dedup.forget(func(k promptDedupKey) bool { return k.turnID == turn })
	}
}

// SendEvent applies the same notification rules for paths that do not emit through Sink.
func SendEvent(sender Sender, cfg config.NotificationsConfig, e event.Event) {
	if !cfg.Enabled || sender == nil {
		return
	}
	// ReplayOnly marks a prompt replay re-emission: the controller re-publishes a
	// still-blocked ApprovalRequest/AskRequest/MCPInteractionRequest so a
	// reloaded or reconnected frontend can rebuild its card. The user is already
	// looking at that prompt, so a replay must never ask for attention again —
	// each frontend replay (load, tab switch, runtime attach, runtime-status
	// refresh) would otherwise push another system notification.
	if e.ReplayOnly {
		return
	}
	if msg, ok := message(cfg, e); ok {
		_ = sender.Send(msg)
	}
}

func message(cfg config.NotificationsConfig, e event.Event) (Message, bool) {
	switch e.Kind {
	case event.TurnDone:
		if cfg.TurnDone {
			if e.Err != nil {
				return Message{Title: "Reasonix", Body: "Turn failed"}, true
			}
			return Message{Title: "Reasonix", Body: "Turn finished"}, true
		}
	case event.ApprovalRequest:
		if cfg.ApprovalRequest {
			return Message{Title: "Reasonix", Body: "Approval needed"}, true
		}
	case event.AskRequest:
		if cfg.AskRequest {
			return Message{Title: "Reasonix", Body: "Question needs your answer"}, true
		}
	}
	return Message{}, false
}
