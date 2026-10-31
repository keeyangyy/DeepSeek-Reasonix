package agent

import (
	"testing"

	"reasonix/internal/provider"
)

// anchorFixture leaves the agent with the anchor a request would have stored:
// the current visible view plus the projection it was measured against.
func anchorFixture(t *testing.T) (*Agent, requestCalibrationShape) {
	t.Helper()
	a := usageFixture(t, 6)
	shape := a.visibleRequestShape(a.modelVisibleMessages())
	a.sess.output.usageAnchor.Store(&usageAnchor{visible: shape, projectionVersion: a.currentProjectionVersion()})
	return a, shape
}

// Without an anchor the gauge is the local estimate. This is the pre-first-turn
// and post-fold state, and it must stay available.
func TestContextUsedTokensFallsBackToTheEstimateWithoutAnchor(t *testing.T) {
	a := usageFixture(t, 6)
	want := a.estimatedShapeTokens(a.visibleRequestShape(a.modelVisibleMessages()))
	if got := a.ContextUsedTokens(); got != want {
		t.Fatalf("gauge = %d, want the local estimate %d", got, want)
	}
}

// With an anchor the provider's own count is the reading: it outranks the
// estimate, so an idle session keeps showing the number the provider reported
// instead of jumping whenever the chars-per-token ratio is re-calibrated.
func TestContextUsedTokensUsesProviderAnchor(t *testing.T) {
	a, _ := anchorFixture(t)
	a.anchorUsage(&provider.Usage{PromptTokens: 5_000})

	if got := a.ContextUsedTokens(); got != 5_000 {
		t.Fatalf("gauge = %d, want the provider-reported 5000", got)
	}
}

// Growth after the anchored request is priced as a delta on both sides, so a
// stale ratio cancels instead of scaling the whole number.
func TestProviderReportedFloorAddsViewGrowth(t *testing.T) {
	a, shape := anchorFixture(t)
	a.anchorUsage(&provider.Usage{PromptTokens: 5_000})

	grown := shape
	grown.requestChars += 4_000
	floor, ok := a.providerReportedFloor(grown, a.currentProjectionVersion())
	if !ok {
		t.Fatal("anchor should still apply while the projection is unchanged")
	}
	gain := a.estimatedShapeTokens(grown) - a.estimatedShapeTokens(shape)
	if want := 5_000 + gain; floor != want {
		t.Fatalf("floor = %d, want %d (5000 + growth %d)", floor, want, gain)
	}
	if gain <= 0 {
		t.Fatalf("growth must be positive for a larger view, got %d", gain)
	}
}

// A fold changes the projection, so the reported size describes a context that
// no longer exists: the anchor must stop applying until the next request.
func TestProviderReportedFloorIgnoresAnchorFromAnotherProjection(t *testing.T) {
	a, shape := anchorFixture(t)
	a.anchorUsage(&provider.Usage{PromptTokens: 5_000})

	if floor, ok := a.providerReportedFloor(shape, a.currentProjectionVersion()+1); ok {
		t.Fatalf("stale anchor still applied (floor = %d); a folded projection must fall back to the estimate", floor)
	}
}

// Reconstructed usage is not a provider count: anchoring it would let the host's
// own guess masquerade as telemetry.
func TestAnchorUsageIgnoresReconstructedUsage(t *testing.T) {
	a, shape := anchorFixture(t)
	a.anchorUsage(&provider.Usage{Estimated: true, PromptTokens: 9_000})

	if anchor := a.sess.output.usageAnchor.Load(); anchor == nil || anchor.promptTokens != 0 {
		t.Fatalf("reconstructed usage anchored the gauge: %+v", anchor)
	}
	if _, ok := a.providerReportedFloor(shape, a.currentProjectionVersion()); ok {
		t.Fatal("an anchor with no provider count must not answer a floor")
	}
}

// A different transcript cannot inherit the previous one's anchor.
func TestSessionSwitchDropsTheAnchor(t *testing.T) {
	a, _ := anchorFixture(t)
	a.anchorUsage(&provider.Usage{PromptTokens: 5_000})

	a.sess.output.reset()

	if anchor := a.sess.output.usageAnchor.Load(); anchor != nil {
		t.Fatalf("anchor survived a session switch: %+v", anchor)
	}
}
