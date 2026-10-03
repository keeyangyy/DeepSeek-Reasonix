package agent

import (
	"fmt"
	"log/slog"

	"reasonix/internal/event"
	"reasonix/internal/i18n"
	"reasonix/internal/provider"
)

// Reasons a request ends up carrying the whole canonical transcript instead of a
// projection. Named so the fallback is diagnosable rather than silent: it is the
// path that can exceed the provider window (measured 1092 messages / 5.6MB).
const (
	projectionFallbackNoProjection  = "no_projection"
	projectionFallbackCoveredPrefix = "covered_prefix_mismatch"
	projectionFallbackLineage       = "lineage_mismatch"
	projectionFallbackEmptyView     = "empty_projection_view"
)

// projectionFallbackReason names the check that stopped the bound projection from
// being sent, in the order the fallback path fails: the first one reported is the
// root cause, and the rest only follow from it.
func (a *Agent) projectionFallbackReason(st CompactionState, msgs []provider.Message) string {
	switch {
	case len(st.Projection.Messages) == 0:
		return projectionFallbackNoProjection
	case !projectionContentValid(st, msgs):
		return projectionFallbackCoveredPrefix
	}
	if key := a.currentPromptCacheKey(); key != "" {
		if _, ok := lineageKeyCompatible(st.PromptCacheKey, key); !ok {
			return projectionFallbackLineage
		}
	}
	return projectionFallbackEmptyView
}

// reportProjectionFallback records that this request sends the whole transcript.
// The fold was either never built, no longer matches the transcript, or belongs
// to another lineage and could not be re-stamped — none of which said anything
// before, leaving the 400 that follows impossible to attribute.
func (a *Agent) reportProjectionFallback(msgs []provider.Message) {
	if a == nil || a.sess.conversation == nil {
		return
	}
	a.sess.compactionMu.Lock()
	st := a.sess.compactionState
	a.sess.compactionMu.Unlock()
	reason := a.projectionFallbackReason(st, msgs)
	slog.Warn("agent: sending the full transcript, projection unusable",
		"reason", reason, "messages", len(msgs), "cache_key", a.currentPromptCacheKey())
	if a.svc.sink == nil {
		return
	}
	a.svc.sink.Emit(event.Event{
		Kind:   event.Notice,
		Level:  event.LevelInfo,
		Text:   i18n.M.AgentProjectionFallback,
		Detail: fmt.Sprintf("projection=%s messages=%d", reason, len(msgs)),
	})
}
