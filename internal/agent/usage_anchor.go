package agent

import "reasonix/internal/provider"

// usageAnchor binds one provider-reported prompt size to the visible view that
// request carried. promptTokens stays zero until the usage arrives, so a stream
// that ended without telemetry leaves no anchor to read.
type usageAnchor struct {
	promptTokens      int
	visible           requestCalibrationShape
	projectionVersion uint64
}

// anchorUsage completes the anchor of the request in flight. Reconstructed usage
// is skipped: only a real provider count may anchor the gauge.
func (a *Agent) anchorUsage(usage *provider.Usage) {
	if a == nil || usage == nil || usage.Estimated {
		return
	}
	tokens := usage.LatestPromptTokens()
	sent := a.sess.output.usageAnchor.Load()
	if tokens <= 0 || sent == nil || sent.visible.requestChars <= 0 {
		return
	}
	anchored := *sent
	anchored.promptTokens = tokens
	a.sess.output.usageAnchor.Store(&anchored)
}

// providerReportedFloor is the provider's last prompt size plus what the visible
// view gained since that request, both sides sized by the same local estimate so
// a stale ratio cancels. It answers false after any fold: the reported size
// describes a context that no longer exists, and only the next request anchors
// the new one.
func (a *Agent) providerReportedFloor(visible requestCalibrationShape, projectionVersion uint64) (int, bool) {
	if a == nil {
		return 0, false
	}
	anchor := a.sess.output.usageAnchor.Load()
	if anchor == nil || anchor.promptTokens <= 0 || anchor.projectionVersion != projectionVersion {
		return 0, false
	}
	gain := a.estimatedShapeTokens(visible) - a.estimatedShapeTokens(anchor.visible)
	return max(anchor.promptTokens+gain, 0), true
}

// promptPressure is the one reading of how full the context is: the provider's
// reported size plus the growth since, where there is an anchor, and the local
// estimate where there is none (after a fold, on a rebound session, before the
// first usage). Using the provider's own count as the baseline keeps the gauge
// from jumping every time the chars-per-token ratio is re-calibrated.
func (a *Agent) promptPressure(visible requestCalibrationShape, projectionVersion uint64, estimate int) int {
	if floor, ok := a.providerReportedFloor(visible, projectionVersion); ok {
		return floor
	}
	return estimate
}
