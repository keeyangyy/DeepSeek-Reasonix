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
	projectionFallbackCoveredPrefix = "covered_prefix_mismatch"
	projectionFallbackEmptyView     = "empty_projection_view"
)

// projectionFallbackReason names the check that stopped a bound projection from
// being sent. Only the covered transcript decides that, so the reason is always
// about content; anything else means the spliced view simply came out empty.
func (a *Agent) projectionFallbackReason(st CompactionState, msgs []provider.Message) string {
	if !projectionContentValid(st, msgs) {
		return projectionFallbackCoveredPrefix
	}
	return projectionFallbackEmptyView
}

// reportProjectionFallback records that this request sends the whole transcript.
// The fold was either never built, or no longer matches the transcript — which
// said nothing before, leaving the 400 that follows impossible to attribute.
func (a *Agent) reportProjectionFallback(msgs []provider.Message) {
	// An empty transcript cannot overflow anything, so there is nothing to report
	// and saying so on every probe turn would be pure noise.
	if a == nil || a.sess.conversation == nil || len(msgs) == 0 {
		return
	}
	a.sess.compactionMu.Lock()
	st := a.sess.compactionState
	a.sess.compactionMu.Unlock()
	// A session that was never folded is not an incident: nothing has been lost,
	// and reporting it every turn before the first fold drowns the real signal.
	if len(st.Projection.Messages) == 0 {
		return
	}
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
