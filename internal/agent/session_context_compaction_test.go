package agent

import (
	"slices"
	"strings"
	"testing"

	"reasonix/internal/provider"
	"reasonix/internal/sessioncontext"
)

func TestCompactionFoldsContextsIntoSummaryAndKeepsLatestFoldSnapshot(t *testing.T) {
	old := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "old"}).Content)
	latestSnapshot := sessioncontext.Build(sessioncontext.Sections{Workspace: "new", SkillsCatalog: "catalog"})
	latest := HostGeneratedUserMessage(latestSnapshot.Content)
	region := []provider.Message{
		old,
		{Role: provider.RoleUser, Origin: provider.MessageOriginUser, Content: "first request"},
		{Role: provider.RoleAssistant, Content: "first answer"},
		latest,
		{Role: provider.RoleUser, Origin: provider.MessageOriginUser, Content: "second request"},
		{Role: provider.RoleAssistant, Content: "second answer"},
	}
	a := &Agent{}
	kept, fold, retention := a.partitionFoldForProjectionAt(region, 1, 1+latestSessionContextIndex(region))
	if len(kept) != 1 || kept[0].Content != latestSnapshot.Content || kept[0].Origin != provider.MessageOriginHost {
		t.Fatalf("kept context = %+v", kept)
	}
	// Snapshots fold like any other message so the summarizer replays the same
	// byte-identical prefix the ordinary request sent. The newest is also kept
	// so the projection still carries the live runtime index.
	if len(fold) != len(region) || retention.Dropped != 2 {
		t.Fatalf("fold=%d retention=%+v, want every region message folded", len(fold), retention)
	}
	if !containsSessionContext(fold) {
		t.Fatalf("summarizer input dropped session context, breaking the cached prefix: %+v", fold)
	}

	projection := checkpointProjectionMessages(
		append([]provider.Message{{Role: provider.RoleSystem, Content: "stable"}}, region...),
		1,
		kept,
		"conversation summary",
	)
	if len(projection) != 3 || projection[0].Role != provider.RoleSystem ||
		projection[1].Content != latestSnapshot.Content || projection[1].Origin != provider.MessageOriginHost ||
		!isCompactionSummary(projection[2]) {
		t.Fatalf("checkpoint projection order = %+v", projection)
	}
	model := provider.ModelMessages(projection)
	if model[1].Origin != "" || model[1].Content != latestSnapshot.Content {
		t.Fatalf("provider boundary changed context bytes or kept provenance: %+v", model[1])
	}
}

func TestCompactionFoldsContextsWhenLatestRemainsInRecentTail(t *testing.T) {
	old := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "old"}).Content)
	latest := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "tail"}).Content)
	all := []provider.Message{
		{Role: provider.RoleSystem, Content: "stable"}, old,
		{Role: provider.RoleUser, Content: "fold me"}, {Role: provider.RoleAssistant, Content: "answer"},
		latest, {Role: provider.RoleUser, Content: "recent"},
	}
	a := &Agent{}
	kept, fold, _ := a.partitionFoldForProjectionAt(all[1:4], 1, latestSessionContextIndex(all))
	if len(kept) != 0 || len(fold) != 3 {
		t.Fatalf("kept=%+v fold=%+v, want the region's snapshot folded", kept, fold)
	}
	if !containsSessionContext(fold) {
		t.Fatalf("summarizer input dropped session context, breaking the cached prefix: %+v", fold)
	}
	if all[4].Content != latest.Content {
		t.Fatal("recent-tail context bytes changed")
	}
}

func containsSessionContext(messages []provider.Message) bool {
	return slices.ContainsFunc(messages, isSessionContextMessage)
}

// TestSnapshotRuleOnlyAppliesToContextBearingFolds keeps the extra instruction
// conditional: appending it unconditionally shrinks the summary output budget on
// small windows and breaks chunked-merge recovery.
func TestSnapshotRuleOnlyAppliesToContextBearingFolds(t *testing.T) {
	snapshot := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "/work"}).Content)
	a := &Agent{}
	withContext := a.compactionInstructionFor([]provider.Message{snapshot, {Role: provider.RoleUser, Content: "hi"}}, "")
	if !strings.Contains(withContext, "Never restate host-generated session-context snapshots") {
		t.Fatalf("context-bearing fold lost the snapshot rule: %q", withContext)
	}
	plain := []provider.Message{{Role: provider.RoleUser, Content: "hi"}}
	withoutContext := a.compactionInstructionFor(plain, "")
	if strings.Contains(withoutContext, "Never restate") {
		t.Fatalf("context-free fold gained the snapshot rule: %q", withoutContext)
	}
	if withoutContext != compactionInstructionWithFocus("") {
		t.Fatal("context-free fold must use the unmodified instruction")
	}
}

func TestExplicitCompressionFoldsContextsAndDropsOnlySelectedOldSnapshots(t *testing.T) {
	old := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "old"}).Content)
	latest := HostGeneratedUserMessage(sessioncontext.Build(sessioncontext.Sections{Workspace: "latest"}).Content)
	visible := []provider.Message{
		{Role: provider.RoleSystem, Content: "stable"}, old,
		{Role: provider.RoleUser, Origin: provider.MessageOriginUser, Content: "first request"},
		{Role: provider.RoleAssistant, Content: "first answer"}, latest,
		{Role: provider.RoleUser, Origin: provider.MessageOriginUser, Content: "second request"},
	}
	a := &Agent{}
	plan, ok := a.planVisibleCompression(explicitCompressionSnapshot{visible: visible}, "before", 5, "second")
	if !ok {
		t.Fatalf("plan = %+v", plan)
	}
	// Both snapshots sit inside the selected range, so both enter the summarizer
	// input: the summary request replays the ordinary request's prefix, and
	// omitting them would break that shared prefix (prompt-cache reuse).
	if got := countSessionContexts(plan.fold); got != 2 {
		t.Fatalf("explicit summarizer context count = %d, want both in-range snapshots: %+v", got, plan.fold)
	}
	if !foldMatchesVisiblePrefix(visible, plan.fold) {
		t.Fatal("explicit fold is not a contiguous replay of the visible prefix: cache reuse is forfeited")
	}
	projection := buildVisibleCompressionProjection(visible, plan, "summary")
	if got := countSessionContexts(projection); got != 1 {
		t.Fatalf("projection context count = %d, want latest only: %+v", got, projection)
	}
	if snapshot, ok := latestTurnContextSnapshot(projection); !ok || snapshot.Content != latest.Content {
		t.Fatalf("projection latest context = %+v, %v", snapshot, ok)
	}
}
