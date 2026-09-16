package agent

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// compactedParentFixture writes a parent transcript plus a compacted sidecar
// whose covered region stops short of the transcript tip, which is what a
// session looks like after compaction followed by more work.
func compactedParentFixture(t *testing.T, dir string) (string, []provider.Message, CompactionState) {
	t.Helper()
	parentPath := filepath.Join(dir, "parent.jsonl")
	parent := []provider.Message{{Role: provider.RoleSystem, Content: "system"}}
	for i := range 8 {
		parent = append(parent,
			provider.Message{Role: provider.RoleUser, Content: fmt.Sprintf("question %d", i)},
			provider.Message{Role: provider.RoleAssistant, Content: strings.Repeat("answer work ", 40)},
		)
	}
	covered := len(parent) - 3
	st := CompactionState{
		SchemaVersion:     compactionStateSchemaCurrent,
		TranscriptVersion: 4,
		PromptCacheKey:    promptCacheKey("ws", BranchID(parentPath), "p/m"),
		Projection: ContextProjection{
			Messages: []provider.Message{
				{Role: provider.RoleSystem, Content: "system"},
				{Role: provider.RoleUser, Content: "[compacted context] earlier work"},
			},
			TranscriptVersion: 4, ProjectionVersion: 2,
			CoveredCount: covered, CoveredPrefixHash: coveredPrefixHash(parent, covered),
			PinnedContextHash: pinnedContextCoverageHash(parent, covered),
			SourceTokens:      40_000, ProjectionTokens: 900,
		},
	}
	if err := SaveCompactionState(parentPath, st); err != nil {
		t.Fatalf("save parent projection: %v", err)
	}
	return parentPath, parent, st
}

// TestInheritContextProjectionForForkTrimsToForkBoundary is the regression for a
// fork cut inside the parent's covered region: the inherited projection must be
// trimmed to the fork boundary instead of dropped, so the fork keeps the
// compacted context rather than replaying the whole canonical history.
func TestInheritContextProjectionForForkTrimsToForkBoundary(t *testing.T) {
	dir := t.TempDir()
	parentPath, parent, parentState := compactedParentFixture(t, dir)
	// Cut well inside the covered region.
	forked := append([]provider.Message(nil), parent[:len(parent)-5]...)
	if len(forked) >= parentState.Projection.CoveredCount {
		t.Fatalf("fixture must cut inside the covered region: fork=%d covered=%d",
			len(forked), parentState.Projection.CoveredCount)
	}
	childPath := filepath.Join(dir, "child.jsonl")
	sess := NewSession("")
	sess.Messages = forked
	if err := sess.Save(childPath); err != nil {
		t.Fatalf("save fork: %v", err)
	}

	inherited, err := sess.InheritContextProjectionForFork(parentPath, childPath, parent)
	if err != nil || !inherited {
		t.Fatalf("inherit = %v err=%v, want an inherited projection", inherited, err)
	}
	child, ok, err := LoadCompactionState(childPath)
	if err != nil || !ok {
		t.Fatalf("load fork projection: ok=%v err=%v", ok, err)
	}
	if child.Projection.CoveredCount != len(forked) {
		t.Fatalf("fork covered count = %d, want the fork boundary %d", child.Projection.CoveredCount, len(forked))
	}
	if got, want := child.Projection.CoveredPrefixHash, coveredPrefixHash(forked, len(forked)); got != want {
		t.Fatalf("fork covered hash = %q, want %q", got, want)
	}
	if got, want := len(child.Projection.Messages), len(parentState.Projection.Messages); got != want {
		t.Fatalf("fork projection body = %d messages, want the parent's compacted %d", got, want)
	}

	// End to end: the reopened fork serves the compacted body, not the history.
	loaded, err := LoadSession(childPath)
	if err != nil {
		t.Fatalf("load fork session: %v", err)
	}
	a := New(nil, tool.NewRegistry(), loaded, Options{
		SessionPath: childPath, WorkspaceID: "ws", ModelRef: "p/m", ContextWindow: 200_000,
	}, event.Discard)
	if visible := a.modelVisibleMessages(); len(visible) != len(parentState.Projection.Messages) {
		t.Fatalf("fork visible messages = %d, want the compacted %d (full-history replay)",
			len(visible), len(parentState.Projection.Messages))
	}
	snap := a.ContextMaintenanceSnapshot()
	if snap.CheckpointState == "none" {
		t.Fatalf("fork did not restore its projection: %+v", snap)
	}
	if snap.ProjectedTokens >= snap.CanonicalTokens {
		t.Fatalf("fork context not compacted: projected=%d canonical=%d", snap.ProjectedTokens, snap.CanonicalTokens)
	}
}

// TestInheritContextProjectionForForkKeepsCoveragePastTheCut keeps the existing
// behavior for a fork cut after the covered region: the parent coverage and its
// own fingerprint survive untouched, and the tail splices from canonical.
func TestInheritContextProjectionForForkKeepsCoveragePastTheCut(t *testing.T) {
	dir := t.TempDir()
	parentPath, parent, parentState := compactedParentFixture(t, dir)
	forked := append([]provider.Message(nil), parent...)
	childPath := filepath.Join(dir, "child.jsonl")
	sess := NewSession("")
	sess.Messages = forked
	if err := sess.Save(childPath); err != nil {
		t.Fatalf("save fork: %v", err)
	}

	inherited, err := sess.InheritContextProjectionForFork(parentPath, childPath, parent)
	if err != nil || !inherited {
		t.Fatalf("inherit = %v err=%v, want an inherited projection", inherited, err)
	}
	child, ok, err := LoadCompactionState(childPath)
	if err != nil || !ok {
		t.Fatalf("load fork projection: ok=%v err=%v", ok, err)
	}
	if child.Projection.CoveredCount != parentState.Projection.CoveredCount {
		t.Fatalf("fork covered count = %d, want the parent's %d",
			child.Projection.CoveredCount, parentState.Projection.CoveredCount)
	}
	if child.Projection.CoveredPrefixHash != parentState.Projection.CoveredPrefixHash {
		t.Fatal("fork rewrote an unaffected parent fingerprint")
	}
	loaded, err := LoadSession(childPath)
	if err != nil {
		t.Fatalf("load fork session: %v", err)
	}
	a := New(nil, tool.NewRegistry(), loaded, Options{
		SessionPath: childPath, WorkspaceID: "ws", ModelRef: "p/m", ContextWindow: 200_000,
	}, event.Discard)
	want := len(parentState.Projection.Messages) + (len(forked) - parentState.Projection.CoveredCount)
	if visible := a.modelVisibleMessages(); len(visible) != want {
		t.Fatalf("fork visible messages = %d, want compacted body plus the uncovered tail %d", len(visible), want)
	}
}

func TestInheritContextProjectionForForkFailsClosed(t *testing.T) {
	newFork := func(t *testing.T, dir string, parent []provider.Message) (*Session, string) {
		t.Helper()
		childPath := filepath.Join(dir, "child.jsonl")
		sess := NewSession("")
		sess.Messages = append([]provider.Message(nil), parent...)
		if err := sess.Save(childPath); err != nil {
			t.Fatalf("save fork: %v", err)
		}
		return sess, childPath
	}

	t.Run("fork is not a parent prefix", func(t *testing.T) {
		dir := t.TempDir()
		parentPath, parent, _ := compactedParentFixture(t, dir)
		sess, childPath := newFork(t, dir, parent)
		sess.Messages[1].Content = "rewritten by someone else"
		inherited, err := sess.InheritContextProjectionForFork(parentPath, childPath, parent)
		if err != nil || inherited {
			t.Fatalf("inherit = %v err=%v, want a refusal", inherited, err)
		}
		if _, ok, _ := LoadCompactionState(childPath); ok {
			t.Fatal("refused fork gained a projection sidecar")
		}
	})

	t.Run("parent has no compacted view", func(t *testing.T) {
		dir := t.TempDir()
		_, parent, _ := compactedParentFixture(t, dir)
		bareParentPath := filepath.Join(dir, "bare.jsonl")
		sess, childPath := newFork(t, dir, parent)
		inherited, err := sess.InheritContextProjectionForFork(bareParentPath, childPath, parent)
		if err != nil || inherited {
			t.Fatalf("inherit = %v err=%v, want a refusal", inherited, err)
		}
	})

	t.Run("fork already owns a sidecar", func(t *testing.T) {
		dir := t.TempDir()
		parentPath, parent, _ := compactedParentFixture(t, dir)
		sess, childPath := newFork(t, dir, parent)
		existing := CompactionState{
			SchemaVersion:  compactionStateSchemaCurrent,
			PromptCacheKey: "other|writer|p/m",
			Projection: ContextProjection{
				Messages: []provider.Message{{Role: provider.RoleSystem, Content: "other writer"}},
			},
		}
		if err := SaveCompactionState(childPath, existing); err != nil {
			t.Fatalf("seed fork sidecar: %v", err)
		}
		inherited, err := sess.InheritContextProjectionForFork(parentPath, childPath, parent)
		if err != nil || inherited {
			t.Fatalf("inherit = %v err=%v, want a refusal", inherited, err)
		}
		after, ok, err := LoadCompactionState(childPath)
		if err != nil || !ok {
			t.Fatalf("load fork sidecar: ok=%v err=%v", ok, err)
		}
		if len(after.Projection.Messages) != 1 || after.PromptCacheKey != "other|writer|p/m" {
			t.Fatalf("refused inherit overwrote the fork sidecar: %+v", after)
		}
	})

	t.Run("parent projection no longer matches its transcript", func(t *testing.T) {
		dir := t.TempDir()
		parentPath, parent, parentState := compactedParentFixture(t, dir)
		parentState.Projection.CoveredCount = len(parent) + 10
		if err := SaveCompactionState(parentPath, parentState); err != nil {
			t.Fatalf("stale parent sidecar: %v", err)
		}
		sess, childPath := newFork(t, dir, parent)
		inherited, err := sess.InheritContextProjectionForFork(parentPath, childPath, parent)
		if err != nil || inherited {
			t.Fatalf("inherit = %v err=%v, want a refusal", inherited, err)
		}
	})
}
