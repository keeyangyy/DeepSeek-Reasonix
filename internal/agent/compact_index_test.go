package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

func foldIndexDisabled() *bool {
	v := false
	return &v
}

func newFoldIndexAgent(reply string, msgs []provider.Message) (*Agent, *recordingProvider, *Session) {
	prov := &recordingProvider{reply: reply}
	sess := &Session{Messages: msgs}
	a := New(prov, tool.NewRegistry(), sess, Options{
		ContextWindow: 50_000, CompactRatio: 0.5, RecentKeep: 2,
	}, event.Discard)
	return a, prov, sess
}

func foldIndexSection(summary string) string {
	_, index := splitFoldIndex(summary)
	return index
}

// A manual fold must attach a host-written index whose #n addresses name real
// canonical positions.
func TestFoldIndexAttachedOnManualCompact(t *testing.T) {
	a, _, sess := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "fix the bug"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "continue"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("more ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	})
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	summary := foldSummaryText(t, a)
	if !strings.Contains(summary, indexSectionHeading) {
		t.Fatalf("summary missing index section:\n%s", summary)
	}
	// The index must address the folded user turns by their canonical
	// positions: recall reads those back verbatim. (The most recent user
	// turns stay verbatim by retention, so only #1 is folded here.)
	want := sess.Messages[1].Content
	res, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{1}})
	if err != nil {
		t.Fatalf("recall #1: %v", err)
	}
	if !strings.Contains(res.Text, want) {
		t.Fatalf("recall #1 missing original %q:\n%s", want, res.Text)
	}
}

// A fold on top of an existing projection must translate positions through
// the projection formula: an address minted by the second fold names the same
// transcript slot the first fold did.
func TestFoldIndexStableAcrossGenerations(t *testing.T) {
	a, _, sess := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "first turn"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("a ", 400)},
		{Role: provider.RoleUser, Content: "second turn"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("b ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	})
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("first compact: %v", err)
	}
	first := foldIndexSection(foldSummaryText(t, a))
	if !strings.Contains(first, "#1 you") {
		t.Fatalf("first index missing #1:\n%s", first)
	}

	sess.Add(provider.Message{Role: provider.RoleUser, Content: "third turn"})
	sess.Add(provider.Message{Role: provider.RoleAssistant, Content: strings.Repeat("c ", 400)})
	sess.Add(provider.Message{Role: provider.RoleUser, Content: "tail2"})
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("second compact: %v", err)
	}
	second := foldIndexSection(foldSummaryText(t, a))
	if !strings.Contains(second, "#1 you") {
		t.Fatalf("second index dropped the #1 address:\n%s", second)
	}
	res, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{1}})
	if err != nil {
		t.Fatalf("recall #1 after second fold: %v", err)
	}
	if !strings.Contains(res.Text, "first turn") {
		t.Fatalf("recall #1 no longer returns the first turn:\n%s", res.Text)
	}
}

// Index lines a model copies into its digest must not survive into the
// projection: the heading split removes the section, and stray lines are
// cleaned by pattern, leaving only the host-written index.
func TestFoldIndexStripsModelRepetition(t *testing.T) {
	contaminated := "## Goal\nfixed the bug\n\n" + indexSectionHeading + "\n- #99 you  \"invented\"\n- #98 bash  echo hacked\n"
	a, _, _ := newFoldIndexAgent(contaminated, []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "fix the bug"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	})
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	summary := foldSummaryText(t, a)
	if strings.Contains(summary, "invented") || strings.Contains(summary, "hacked") {
		t.Fatalf("model-written index lines survived:\n%s", summary)
	}
	if !strings.Contains(summary, indexSectionHeading) {
		t.Fatalf("host index missing after cleanup:\n%s", summary)
	}
	if strings.Contains(summary, "- #99") {
		t.Fatalf("invented address survived:\n%s", summary)
	}
}

// Prose that merely cites an issue number must survive the line-cleaning
// pattern: the kind anchor is what keeps "- #12 fixed the login …" intact.
func TestStripIndexLinesKeepsProse(t *testing.T) {
	prose := "## Errors & fixes\n- #12 修复了登录问题\n- fixed #3 by rerolling\nnormal line"
	got := stripIndexLines(prose)
	if got != prose {
		t.Fatalf("stripIndexLines mangled prose:\n%s", got)
	}
	digest := "## Goal\nwork\n- #7 you  \"quoted opening\"\n- #7 bash  git push"
	got = stripIndexLines(digest)
	if strings.Contains(got, "#7") {
		t.Fatalf("index lines not stripped:\n%s", got)
	}
	if !strings.Contains(got, "work") {
		t.Fatalf("prose lost:\n%s", got)
	}
}

func TestSplitAndMergeFoldIndex(t *testing.T) {
	prose, index := splitFoldIndex("digest body\n\n" + indexSectionHeading + "\n- #1 you  \"a\"")
	if index == "" || !strings.Contains(prose, "digest body") || strings.Contains(prose, indexSectionHeading) {
		t.Fatalf("splitFoldIndex: prose=%q index=%q", prose, index)
	}
	p, i := splitFoldIndex("no index here")
	if i != "" || p != "no index here" {
		t.Fatalf("splitFoldIndex on plain digest: %q %q", p, i)
	}
	merged := mergeFoldIndex(indexSectionHeading+"\n- #1 you  \"old\"", indexSectionHeading+"\n- #9 bash  ls", 10_000)
	if !strings.Contains(merged, "- #1 you") || !strings.Contains(merged, "- #9 bash") {
		t.Fatalf("mergeFoldIndex dropped a side:\n%s", merged)
	}
	// Budget binds from the oldest: the fresh line survives, the old one is
	// summarized away.
	tight := mergeFoldIndex(indexSectionHeading+"\n- #1 you  "+strings.Repeat("old ", 400), indexSectionHeading+"\n- #9 bash  ls", 60)
	if !strings.Contains(tight, "- #9 bash") {
		t.Fatalf("tight merge dropped the fresh line:\n%q", tight)
	}
	if strings.Contains(tight, "- #1 you") {
		t.Fatalf("tight merge kept the old line:\n%q", tight)
	}
}

func TestPriorFoldIndexFrom(t *testing.T) {
	fold := []provider.Message{
		{Role: provider.RoleUser, Content: summaryTagOpen + "\ndigest\n" + indexSectionHeading + "\n- #1 you  \"x\"\n" + summaryTagClose},
		{Role: provider.RoleUser, Content: "plain"},
	}
	prior := priorFoldIndexFrom(fold)
	if !strings.Contains(prior, "- #1 you") {
		t.Fatalf("prior index not carried:\n%s", prior)
	}
	if priorFoldIndexFrom(fold[1:]) != "" {
		t.Fatal("priorFoldIndexFrom invented an index")
	}
}

// The ledger survives a failed generation (bumped, spend kept) and resets on
// a successful one.
func TestRecallLedgerOnBlockedAndCommit(t *testing.T) {
	a, _, _ := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "x"},
	})
	commit := summaryProjectionCommit{generation: 4}
	state := a.summaryProjectionState(commit)
	if state.Recall.Generation != 5 || state.Recall.SpentTokens != 0 {
		t.Fatalf("commit did not reset the ledger: %+v", state.Recall)
	}
	// A blocked receipt advances the generation but must keep the spend.
	a.sess.compactionState = CompactionState{
		Generation: 5,
		Recall:     RecallLedger{Generation: 5, SpentTokens: 700},
	}
	a.recordContextMaintenanceOutcome("hash", CompactionTriggerPressure, "summary", "blocked", "test")
	if a.sess.compactionState.Generation != 6 {
		t.Fatalf("blocked did not advance generation: %d", a.sess.compactionState.Generation)
	}
	if a.sess.compactionState.Recall.SpentTokens != 700 {
		t.Fatalf("blocked reset the spend: %+v", a.sess.compactionState.Recall)
	}
	if a.sess.compactionState.Recall.Generation != 6 {
		t.Fatalf("ledger generation not bumped: %+v", a.sess.compactionState.Recall)
	}
}

// A disabled index leaves digests untouched and recall explicit about it.
func TestFoldIndexDisabled(t *testing.T) {
	prov := &recordingProvider{reply: "digest"}
	sess := &Session{Messages: []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "fix the bug"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	}}
	a := New(prov, tool.NewRegistry(), sess, Options{
		ContextWindow: 50_000, CompactRatio: 0.5, RecentKeep: 2, FoldIndex: foldIndexDisabled(),
	}, event.Discard)
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	summary := foldSummaryText(t, a)
	if strings.Contains(summary, indexSectionHeading) {
		t.Fatalf("disabled index still attached:\n%s", summary)
	}
	if _, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{1}}); err == nil {
		t.Fatal("recall succeeded with the index disabled")
	}
}

// Recall of an unfolded position is a usage error, not a transcript read.
func TestRecallRejectsUnfoldedAndEmpty(t *testing.T) {
	a, _, _ := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "fix the bug"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	})
	if _, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{0}}); err == nil {
		t.Fatal("recall before any fold succeeded")
	}
	if _, err := a.RecallContext(context.Background(), tool.RecallRequest{}); err == nil {
		t.Fatal("recall without positions or query succeeded")
	}
	if _, err := a.RecallContext(context.Background(), tool.RecallRequest{Positions: []int{1}, Query: "x"}); err == nil {
		t.Fatal("recall with both positions and query succeeded")
	}
}

// A query that matches folded CJK content must surface its address.
func TestRecallSearchFindsCJK(t *testing.T) {
	a, _, sess := newFoldIndexAgent("digest", []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "修复登录的bug"},
		{Role: provider.RoleAssistant, Content: strings.Repeat("work ", 400)},
		{Role: provider.RoleUser, Content: "tail"},
	})
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	res, err := a.RecallContext(context.Background(), tool.RecallRequest{Query: "登录"})
	if err != nil {
		t.Fatalf("recall search: %v", err)
	}
	if !strings.Contains(res.Text, "登录") {
		t.Fatalf("search missed the folded CJK turn:\n%s", res.Text)
	}
	_ = sess
}

func foldSummaryText(t *testing.T, a *Agent) string {
	t.Helper()
	for _, m := range a.modelVisibleMessages() {
		if isCompactionSummary(m) {
			return m.Content
		}
	}
	t.Fatal("no compaction summary in the visible view")
	return ""
}
