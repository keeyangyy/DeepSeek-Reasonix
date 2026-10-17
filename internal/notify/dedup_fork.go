package notify

import (
	"sync"

	"reasonix/internal/event"
)

// promptDedupCeiling bounds the dedup set. Entries are released when their
// request is answered or their turn ends (see Sink.forgetResolved), so the set
// normally only holds the prompts that are actually outstanding; the ceiling is
// a safety net against an emitter that never resolves a prompt.
const promptDedupCeiling = 256

// promptDedupKey is the stable identity of one user-facing request.
//
// The request id alone is NOT enough: approvalManager hands out ask/approval ids
// from a per-controller counter that restarts at 1, so two sessions (or the same
// session after a runtime rebuild) can both have a request "1". The turn id
// separates rounds and the session scope separates sessions, which is what keeps
// a genuinely new prompt from being silenced as a duplicate.
type promptDedupKey struct {
	kind    event.Kind
	session string
	turnID  string
	itemID  string
}

// promptDedup remembers which request identities already produced a system
// notification. It is mutex-guarded because a controller's sink can be emitted
// into from several goroutines (provider, prompt gate, background jobs).
type promptDedup struct {
	mu    sync.Mutex
	seen  map[promptDedupKey]struct{}
	order []promptDedupKey
}

// claim records one identity and reports whether it may notify now. The first
// delivery of an identity wins; every repeat is suppressed until the entry is
// released or evicted. This is identity-based, never time-based.
func (d *promptDedup) claim(k promptDedupKey) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen == nil {
		d.seen = make(map[promptDedupKey]struct{}, promptDedupCeiling)
	}
	if _, ok := d.seen[k]; ok {
		return false
	}
	d.seen[k] = struct{}{}
	d.order = append(d.order, k)
	for len(d.order) > promptDedupCeiling {
		delete(d.seen, d.order[0])
		d.order = d.order[1:]
	}
	return true
}

// forget drops every identity the match selects, so a prompt that has been
// resolved (answered) or whose turn has ended can never suppress a later one.
func (d *promptDedup) forget(match func(promptDedupKey) bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.order) == 0 {
		return
	}
	kept := make([]promptDedupKey, 0, len(d.order))
	for _, k := range d.order {
		if match(k) {
			delete(d.seen, k)
			continue
		}
		kept = append(kept, k)
	}
	d.order = kept
}

// requestIdentity extracts the notification identity of an attention request.
// ok=false means the event carries no request identity at all (TurnDone,
// notices, …): such events keep their previous behaviour and are never
// suppressed, so the dedup can not swallow an announcement it cannot identify.
//
// scope names the session the sink belongs to (one sink per tab/controller); it
// is only consulted when the event itself carries no session path.
func requestIdentity(e event.Event, scope string) (promptDedupKey, bool) {
	switch e.Kind {
	case event.AskRequest, event.ApprovalRequest, event.MCPInteractionRequest:
	default:
		return promptDedupKey{}, false
	}
	itemID := e.ItemID
	turnID := e.TurnID
	if itemID == "" || turnID == "" {
		switch e.Kind {
		case event.AskRequest:
			if itemID == "" {
				itemID = e.Ask.ID
			}
			if turnID == "" {
				turnID = e.Ask.TurnID
			}
		case event.ApprovalRequest:
			if itemID == "" {
				itemID = e.Approval.ID
			}
			if turnID == "" {
				turnID = e.Approval.TurnID
			}
		case event.MCPInteractionRequest:
			if itemID == "" {
				itemID = e.MCPInteraction.ID
			}
			if turnID == "" {
				turnID = e.MCPInteraction.TurnID
			}
		}
	}
	if itemID == "" {
		// No request id: a repeat cannot be told apart from a new request, so
		// fail open and notify rather than risk hiding a prompt the user owes.
		return promptDedupKey{}, false
	}
	session := e.SessionPath
	if session == "" {
		session = scope
	}
	return promptDedupKey{kind: e.Kind, session: session, turnID: turnID, itemID: itemID}, true
}
