package control

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// forkProjectionController builds a compacted session whose projection covers
// most of the transcript, which is the shape a fork button meets after the
// session has been compacted and then grown again.
func forkProjectionController(t *testing.T) (*Controller, *agent.Agent, string) {
	t.Helper()
	dir := schemaOneTempDir(t)
	path := agent.NewSessionPath(dir, "main")
	sess := agent.NewSession("sys")
	sess.Add(provider.Message{Role: provider.RoleUser, Content: "task"})
	sess.Add(provider.Message{Role: provider.RoleAssistant, Content: "ok"})
	for i := range 30 {
		id := fmt.Sprintf("bulk-%d", i)
		sess.Add(provider.Message{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: id, Name: "read_file", Arguments: "{}"}}})
		sess.Add(provider.Message{Role: provider.RoleTool, ToolCallID: id, Name: "read_file", Content: strings.Repeat("line\n", 200)})
	}
	if err := sess.Save(path); err != nil {
		t.Fatalf("save session: %v", err)
	}
	if _, err := agent.EnsureBranchMeta(path); err != nil {
		t.Fatalf("ensure branch meta: %v", err)
	}
	prov := &scriptedTurns{turns: [][]provider.Chunk{textTurn("summary")}}
	exec := agent.New(prov, tool.NewRegistry(), sess, agent.Options{
		SessionPath: path, ContextWindow: 10_000, CompactRatio: 0.8, RecentKeep: 2,
		WorkspaceID: "ws", ModelRef: "p/m",
	}, event.Discard)
	c := New(Options{Executor: exec, SessionDir: dir, Label: "test", DisableColdResumePrune: true})
	c.Resume(sess, path)
	if err := exec.CompactNow(context.Background(), ""); err != nil {
		t.Fatalf("CompactNow: %v", err)
	}
	return c, exec, path
}

// TestForkSessionInheritsCompactedProjectionInsideCoveredRegion is the
// regression for GitHub-visible fork blowup: forking a turn that sits inside
// the parent's compacted region used to drop the projection, so the fork
// replayed the whole canonical history instead of the compacted view.
func TestForkSessionInheritsCompactedProjectionInsideCoveredRegion(t *testing.T) {
	c, exec, path := forkProjectionController(t)
	parentState, ok, err := agent.LoadCompactionState(path)
	if err != nil || !ok || parentState.Projection.ProjectionVersion == 0 {
		t.Fatalf("parent projection missing: ok=%v err=%v", ok, err)
	}
	total := len(exec.Session().Snapshot())
	boundary := parentState.Projection.CoveredCount - 1
	if boundary <= 0 || boundary >= total {
		t.Fatalf("fixture boundary %d outside 1..%d (covered=%d, total=%d)",
			boundary, total-1, parentState.Projection.CoveredCount, total)
	}
	// Fork a turn that starts before the compacted region ends. Checkpoints
	// record turn-start indexes; a real turn provides them, so inject one.
	c.checkpoints.mu.Lock()
	c.checkpoints.bound[0] = boundary
	c.checkpoints.mu.Unlock()

	newPath, err := c.ForkSession(0, "")
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if newPath == "" || newPath == path {
		t.Fatalf("fork path = %q, want a distinct session path", newPath)
	}
	child, ok, err := agent.LoadCompactionState(newPath)
	if err != nil || !ok || len(child.Projection.Messages) == 0 {
		t.Fatalf("fork inherited no projection (ok=%v err=%v): the fork replays the full history", ok, err)
	}
	if child.Projection.CoveredCount != boundary {
		t.Fatalf("fork covered count = %d, want the fork boundary %d", child.Projection.CoveredCount, boundary)
	}
	if got, want := len(child.Projection.Messages), len(parentState.Projection.Messages); got != want {
		t.Fatalf("fork projection body = %d messages, want the parent's compacted %d", got, want)
	}
	if child.Projection.ProjectionVersion != parentState.Projection.ProjectionVersion {
		t.Fatalf("fork rebuilt the projection: version %d -> %d",
			parentState.Projection.ProjectionVersion, child.Projection.ProjectionVersion)
	}

	loaded, err := agent.LoadSession(newPath)
	if err != nil {
		t.Fatalf("load fork session: %v", err)
	}
	// A fork can cut between a tool call and its result; loading then appends
	// the interrupted-turn repair, so the transcript is at least the boundary.
	if got := len(loaded.Snapshot()); got < boundary {
		t.Fatalf("fork transcript = %d messages, want at least the fork boundary %d", got, boundary)
	}
	childAgent := agent.New(nil, tool.NewRegistry(), loaded, agent.Options{
		SessionPath: newPath, WorkspaceID: "ws", ModelRef: "p/m", ContextWindow: 10_000,
	}, event.Discard)
	snap := childAgent.ContextMaintenanceSnapshot()
	if snap.CheckpointState == "none" {
		t.Fatalf("fork restored no projection: %+v", snap)
	}
	if snap.ProjectedTokens >= snap.CanonicalTokens {
		t.Fatalf("fork context not compacted: projected=%d canonical=%d", snap.ProjectedTokens, snap.CanonicalTokens)
	}
}
