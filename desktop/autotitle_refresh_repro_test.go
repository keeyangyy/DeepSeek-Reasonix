package main

import (
	"os"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/control"
	"reasonix/internal/provider"
)

// Reproduction tests for the session-title/UI disconnect: explicit renames
// persisted CustomTitle while the sidebar renders TopicTitle, so labels never
// changed. These must fail before the fix and pass after.

// newAIRenameTestApp builds an app + controller pair wired the same way as
// TestAIRenameSessionWritesCanonicalAndLegacyTitles, bound to a project scope
// so runtime sidebar snapshots include the tab.
func newAIRenameTestApp(t *testing.T, name, prompt string) (*App, *control.Controller, string) {
	t.Helper()
	dir := t.TempDir()
	path := agent.NewSessionPath(dir, name)
	writeHistoryTestSession(t, path, prompt)
	chunks := make(chan provider.Chunk, 2)
	chunks <- provider.Chunk{Type: provider.ChunkText, Text: `"Debug login redirect loop"`}
	chunks <- provider.Chunk{Type: provider.ChunkDone}
	close(chunks)
	ctrl := newDesktopSessionTitleController(dir, path, &desktopSessionTitleProvider{chunks: chunks})
	app := NewApp()
	installDesktopSessionTitleTab(app, ctrl, "topic-login", path)
	// Bind the tab to a project scope + workspace root so runtime sidebar
	// snapshots include it (global-scope tabs are grouped separately).
	app.mu.Lock()
	tab := app.tabs["test"]
	tab.Scope = "project"
	tab.WorkspaceRoot = dir
	app.mu.Unlock()
	t.Cleanup(func() { ctrl.Close() })
	return app, ctrl, path
}

// TestAIRenameSessionUpdatesTopicTitle reproduces the sidebar disconnect:
// after AIRenameSession the topic layer (topic state store) must reflect the
// new title, otherwise the sidebar topic label never changes.
func TestAIRenameSessionUpdatesTopicTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	app, _, _ := newAIRenameTestApp(t, "topic-sync", "debug the login redirect loop")

	title, err := app.AIRenameSession("topic-login")
	if err != nil {
		t.Fatalf("AIRenameSession: %v", err)
	}
	if title != "Debug login redirect loop" {
		t.Fatalf("title = %q", title)
	}

	app.mu.RLock()
	tab := app.tabs["test"]
	app.mu.RUnlock()
	if tab == nil {
		t.Fatalf("test tab missing")
	}
	got := loadTopicTitles(normalizeProjectRoot(tab.WorkspaceRoot))["topic-login"]
	if got != title {
		t.Fatalf("topic layer not updated after AI rename: got %q, want %q", got, title)
	}
	if source := loadTopicTitleSources(normalizeProjectRoot(tab.WorkspaceRoot))["topic-login"]; source != topicTitleSourceManual {
		t.Fatalf("topic source after AI rename = %q, want %q", source, topicTitleSourceManual)
	}
}

// TestAIRenameSessionPropagatesToTab: the runtime tab must carry the new
// title/source, or runtime sidebar snapshots render the stale label.
func TestAIRenameSessionPropagatesToTab(t *testing.T) {
	isolateDesktopUserDirs(t)
	app, _, _ := newAIRenameTestApp(t, "tab-sync", "debug the login redirect loop")

	title, err := app.AIRenameSession("topic-login")
	if err != nil {
		t.Fatalf("AIRenameSession: %v", err)
	}

	app.mu.RLock()
	tab := app.tabs["test"]
	app.mu.RUnlock()
	if tab == nil {
		t.Fatalf("test tab missing")
	}
	if tab.TopicTitle != title {
		t.Fatalf("tab.TopicTitle = %q, want %q", tab.TopicTitle, title)
	}
	if tab.topicTitleSource != topicTitleSourceManual {
		t.Fatalf("tab.topicTitleSource = %q, want %q", tab.topicTitleSource, topicTitleSourceManual)
	}
}

// TestRuntimeSessionChildLabelPrefersCustomTitle reproduces the runtime
// session-child label regression: with two sessions in one topic the runtime
// tree emits per-session children whose label used to be the bare file name,
// ignoring the session's custom title entirely.
func TestRuntimeSessionChildLabelPrefersCustomTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	projectRoot := t.TempDir()
	sessionDir := desktopSessionDir(projectRoot)
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	pathA := writeTopicSession(t, sessionDir, "a.jsonl", "topic-login", "Topic A", projectRoot)
	pathB := writeTopicSession(t, sessionDir, "b.jsonl", "topic-login", "Topic A", projectRoot)
	custom := "AI Debug Title"
	if err := agent.RenameSession(pathB, custom); err != nil {
		t.Fatalf("RenameSession: %v", err)
	}

	app := NewApp()
	tab := &WorkspaceTab{
		ID: "test", Scope: "project", WorkspaceRoot: projectRoot,
		TopicID: "topic-login", TopicTitle: "Topic A",
		SessionPath: pathA,
		Ctrl:        &activationStubController{sessionPath: pathA},
		Ready:       true,
	}
	app.tabs["test"] = tab
	app.tabOrder = []string{"test"}
	app.activeTabID = "test"
	// A second detached session turns the topic into a multi-session topic,
	// which is the runtime path that renders per-session children.
	app.detachedSessions["detached"] = &WorkspaceTab{
		ID: "detached", Scope: "project", WorkspaceRoot: projectRoot,
		TopicID: "topic-login", TopicTitle: "Topic A",
		SessionPath: pathB,
		Ctrl:        &activationStubController{sessionPath: pathB},
	}

	snapshot := app.GetProjectTreeRuntimeSnapshot()
	if len(snapshot.Topics) != 1 {
		t.Fatalf("runtime snapshot topics = %+v, want one", snapshot.Topics)
	}
	children := snapshot.Topics[0].Node.Children
	if len(children) != 2 {
		t.Fatalf("runtime topic children = %+v, want two session children", children)
	}
	labels := map[string]string{}
	for _, child := range children {
		labels[child.SessionPath] = child.Label
	}
	if labels[pathB] != custom {
		t.Fatalf("runtime child label for %s = %q, want custom title %q", pathB, labels[pathB], custom)
	}
}
