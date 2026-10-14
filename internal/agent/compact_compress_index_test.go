package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// The explicit compression path (compress tool, SummarizeUpTo/From, the
// manual button) must attach the same host-written index as the automatic
// path: a digest from either fold is addressed the same way.
func TestFoldIndexAttachedOnCompressToolPath(t *testing.T) {
	a, _, sess := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "first user turn"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "anchor turn"},
		{Role: provider.RoleAssistant, Content: "short reply"},
	})
	res, err := a.CompressContext(context.Background(), tool.CompressRequest{
		Direction: "before",
		Anchor:    "anchor turn",
	})
	if err != nil {
		t.Fatalf("CompressContext: %v", err)
	}
	if res.Status != "ok" {
		t.Fatalf("compress status %q reason %q", res.Status, res.Reason)
	}
	summary := foldSummaryText(t, a)
	if !strings.Contains(summary, indexSectionHeading) {
		t.Fatalf("compress-path summary missing index section:\n%s", summary)
	}
	if !strings.Contains(summary, "#1 you") {
		t.Fatalf("compress-path index missing the folded #1 turn:\n%s", foldIndexSection(summary))
	}
	// The address must read back the canonical original, byte for byte.
	recalled, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{1}})
	if err != nil {
		t.Fatalf("recall after compress: %v", err)
	}
	if !strings.Contains(recalled.Text, sess.Messages[1].Content) {
		t.Fatalf("recall after compress missing the original:\n%s", recalled.Text)
	}
}

// context_budget reports the distance to the compaction trigger, never a raw
// window figure, and stays measurable before any fold.
func TestContextBudgetReportsTriggerDistance(t *testing.T) {
	a, _, _ := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "hello"},
	})
	budget := a.ContextBudget()
	if budget.Window <= 0 || budget.CompactAt <= 0 {
		t.Fatalf("budget unmeasured: %+v", budget)
	}
	if budget.TokensRemaining < 0 || budget.TokensUsed < 0 {
		t.Fatalf("budget negative: %+v", budget)
	}
	if budget.CompactAt > budget.Window {
		t.Fatalf("trigger %d above window %d", budget.CompactAt, budget.Window)
	}
}
