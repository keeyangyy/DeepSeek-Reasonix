package agent

import (
	"reasonix/internal/provider"
)

// RecallLedger tracks what this compaction generation has spent pulling
// folded content back. Carrying the generation it belongs to is what resets
// the budget: a stale generation reads as an unspent one, with no reset call
// to forget.
type RecallLedger struct {
	Generation  uint64 `json:"generation,omitempty"`
	SpentTokens int    `json:"spent_tokens,omitempty"`
}

// projectionValid reports whether st can be reused for the current transcript
// and provider/model lineage. Fail closed: missing CoveredPrefixHash or a blank
// sidecar PromptCacheKey when the current lineage key is known forces rebuild.
// projectionValid reports whether the bound projection can still be sent. Only the
// transcript it covers decides that: the provider/model lineage is deliberately not
// consulted, so a model or workspace switch keeps a summary that still matches the
// history. A window too small for the fold is caught by the send-time size check,
// not by dropping it here.
func projectionValid(st CompactionState, msgs []provider.Message) bool {
	return projectionContentValid(st, msgs)
}
