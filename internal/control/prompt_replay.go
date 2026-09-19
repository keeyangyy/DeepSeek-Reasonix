package control

import (
	"reasonix/internal/event"
)

// emitPendingPrompts re-publishes the currently blocked prompts to one sink.
// ReplayOnly marks every re-emission: the ledger keeps exactly the original
// request (see turnEventDurableSink.EmitChecked), so repeated tab re-attaches
// no longer append duplicate gate rows.
func (c *Controller) emitPendingPrompts(sink event.Sink, approvals []event.Approval, asks []event.Ask, interactions []event.MCPInteraction) {
	if sink == nil {
		return
	}
	for _, a := range approvals {
		if identity, ok := c.promptOwner.Identity(a.ID); ok {
			a.TurnID = identity.TurnID
		}
		replayed := c.approvalRequestEvent(a)
		replayed.ReplayOnly = true
		sink.Emit(replayed)
	}
	for _, a := range asks {
		if identity, ok := c.promptOwner.Identity(a.ID); ok {
			a.TurnID = identity.TurnID
		}
		sink.Emit(event.Event{Kind: event.AskRequest, TurnID: a.TurnID, ItemID: a.ID, Ask: a, ReplayOnly: true})
	}
	for _, i := range interactions {
		if identity, ok := c.promptOwner.Identity(i.ID); ok {
			i.TurnID = identity.TurnID
		}
		sink.Emit(event.Event{Kind: event.MCPInteractionRequest, TurnID: i.TurnID, ItemID: i.ID, MCPInteraction: i, ReplayOnly: true})
	}
}
