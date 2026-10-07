package agent

import (
	"encoding/json"

	"reasonix/internal/contract/event"
	"reasonix/internal/contract/tool"
)

// delegationProfile reports the sub-agents a call dispatches. A nil profile is
// what says the call kept the work in this context.
func delegationProfile(t tool.Tool, args json.RawMessage) *event.Profile {
	pr, ok := t.(interface {
		ResolveProfile(json.RawMessage) *event.Profile
	})
	if !ok {
		return nil
	}
	return pr.ResolveProfile(args)
}
