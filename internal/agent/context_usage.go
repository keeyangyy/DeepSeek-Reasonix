package agent

import "reasonix/internal/tool"

// contextUsage memoises the projected prompt size. The estimate walks every
// visible message, and status gauges redraw far more often than the view moves,
// so it is keyed on everything that can change the answer: the transcript,
// projection, calibration, and provider-visible tool schemas.
type contextUsage struct {
	transcriptVersion  uint64
	projectionVersion  uint64
	calibration        *promptTokenCalibration
	anchor             *usageAnchor
	tools              *tool.Registry
	toolSchemaRevision uint64
	tokens             int
}

// ContextUsedTokens is the number ContextManager compares against its
// thresholds: the estimated prompt size of the view the next request sends. A
// gauge fed from the last turn's usage instead lags a turn, counts completion
// tokens the trigger ignores, and reads zero on a rebound session — which is
// how a session displays 8% while it is compacting.
func (a *Agent) ContextUsedTokens() int {
	if a == nil {
		return 0
	}
	session := a.Session()
	if session == nil {
		return 0
	}
	transcriptVersion := session.TranscriptVersion()
	projectionVersion := a.currentProjectionVersion()
	calibration := a.sess.output.promptCalibration.Load()
	anchor := a.sess.output.usageAnchor.Load()
	tools := a.svc.tools
	toolSchemaRevision := tools.SchemaRevision()
	if cached := a.sess.output.contextUsage.Load(); cached != nil &&
		cached.transcriptVersion == transcriptVersion &&
		cached.projectionVersion == projectionVersion &&
		cached.calibration == calibration &&
		cached.anchor == anchor &&
		cached.tools == tools &&
		cached.toolSchemaRevision == toolSchemaRevision {
		return cached.tokens
	}
	// The gauge and the fold trigger read one number: the provider's own count
	// plus the growth since, when a request is anchored, and the local estimate
	// otherwise (after a fold, on a rebound session, before the first usage).
	visible := a.modelVisibleMessages()
	shape := a.visibleRequestShape(visible)
	tokens := a.promptPressure(shape, projectionVersion, a.estimatedShapeTokens(shape))
	a.sess.output.contextUsage.Store(&contextUsage{
		transcriptVersion:  transcriptVersion,
		projectionVersion:  projectionVersion,
		calibration:        calibration,
		anchor:             anchor,
		tools:              tools,
		toolSchemaRevision: toolSchemaRevision,
		tokens:             tokens,
	})
	return tokens
}
