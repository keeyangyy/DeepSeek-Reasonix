package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/control"
	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
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

// TestAIRenameSessionEmitsRefreshAfterTopicUpdate guards the ordering fixed
// after user testing: the rename path emits a tree refresh first (topic layer
// still stale at that point), so propagating the title to the topic layer must
// emit its own refresh afterwards, or the sidebar lags until the next click.
func TestAIRenameSessionEmitsRefreshAfterTopicUpdate(t *testing.T) {
	isolateDesktopUserDirs(t)
	app, _, _ := newAIRenameTestApp(t, "refresh-order", "debug the login redirect loop")

	refreshes := 0
	app.projectTreeChangedHook = func() { refreshes++ }

	if _, err := app.AIRenameSession("topic-login"); err != nil {
		t.Fatalf("AIRenameSession: %v", err)
	}
	if refreshes < 2 {
		t.Fatalf("project tree refreshes = %d, want >=2 (rename + topic propagation)", refreshes)
	}
}

// TestReattachBackfillsAutoTitle: switching back to a detached session must
// snapshot its transcript and run the auto-title pass, because TurnDone no
// longer routes to the App while the runtime is detached (app==nil in the
// sink binding), so the topic stayed "新的会话" until the next in-session turn.
func TestReattachBackfillsAutoTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := globalTabWorkspaceRoot()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir session dir: %v", err)
	}

	sourcePath := filepath.Join(dir, "idle-source.jsonl")
	targetPath := filepath.Join(dir, "detached-target.jsonl")
	writeHistoryTestSession(t, sourcePath, "source prompt")
	writeHistoryTestSession(t, targetPath, "debug the payment webhook retry storm")

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}
	// Real flows index the topic with an auto source when its first user turn
	// lands (ensureTabTopicIndexedForUserTurn); without it the auto-title
	// gate (source != auto) refuses before the transcript is ever read.
	if err := ensureTopicIndexedWithCreatedAt(
		"global", "", "topic-detached", defaultTopicTitle, topicTitleSourceAuto, time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("index detached topic: %v", err)
	}
	sourceSink := &tabEventSink{tabID: "visible", app: app, ctx: app.ctx}
	targetSink := &tabEventSink{tabID: "detached", app: app}
	installNoopRuntimeEvents(app, sourceSink, targetSink)
	sourceCtrl := control.New(control.Options{
		SessionDir: dir, SessionPath: sourcePath, Label: "source", Sink: sourceSink,
	})
	// The detached target carries transcript content (its turns happened while
	// detached, with autosave stopped). Build the controller the same way
	// controllerWithContent does so the snapshot below has something to write.
	targetSess := agent.NewSession("system")
	targetSess.Add(provider.Message{Role: provider.RoleUser, Content: "debug the payment webhook retry storm"})
	targetSess.Add(provider.Message{Role: provider.RoleAssistant, Content: "acknowledged"})
	targetAg := agent.New(stubProvider{}, tool.NewRegistry(), targetSess, agent.Options{}, event.Discard)
	targetCtrl := control.New(control.Options{
		Executor: targetAg, SessionDir: dir, SessionPath: targetPath, Label: "target", Sink: targetSink,
	})
	tab := &WorkspaceTab{
		ID: "visible", Scope: "global", WorkspaceRoot: root,
		// 这个是"被切走的另一个话题"的 tab：它自己的 TopicID 不是
		// topic-detached，切出时它被 keepOnlyVisibleTab 剪掉/挂起。
		TopicID: "topic-source", TopicTitle: defaultTopicTitle,
		topicTitleSource: topicTitleSourceAuto,
		SessionPath:      sourcePath, Ctrl: sourceCtrl, Ready: true, sink: sourceSink,
		disabledMCP: map[string]ServerView{},
	}
	app.tabs[tab.ID] = tab
	app.tabOrder = []string{tab.ID}
	app.activeTabID = tab.ID
	if err := tab.ensureSessionLease(sourcePath); err != nil {
		t.Fatalf("lease source: %v", err)
	}
	app.mu.Lock()
	app.newSessionRuntimeLocked(tab, sessionRuntimeKey(sourcePath))
	app.advanceSessionRuntimeEpochLocked(tab)
	app.mu.Unlock()

	targetLease, err := agent.TryAcquireSessionLease(targetPath)
	if err != nil {
		t.Fatalf("lease target: %v", err)
	}
	detachedTarget := &WorkspaceTab{
		ID: detachedRuntimeTabID(sessionRuntimeKey(targetPath)), Scope: "global",
		WorkspaceRoot: root, TopicID: "topic-detached", TopicTitle: defaultTopicTitle,
		topicTitleSource: topicTitleSourceAuto,
		SessionPath:      targetPath, Ctrl: targetCtrl,
		Ready: true, sink: targetSink, disabledMCP: map[string]ServerView{},
	}
	detachedTarget.adoptSessionLease(targetLease)
	// The detached turns are on disk only after a snapshot; detached runtimes
	// do not autosave, so persist the transcript the way the out-going
	// switch path (snapshotTabForAction) already does before this point.
	if err := detachedTarget.Ctrl.Snapshot(); err != nil {
		t.Fatalf("snapshot detached target: %v", err)
	}
	app.mu.Lock()
	app.detachedSessions[sessionRuntimeKey(targetPath)] = detachedTarget
	app.newSessionRuntimeLocked(detachedTarget, sessionRuntimeKey(targetPath))
	app.advanceSessionRuntimeEpochLocked(detachedTarget)
	app.mu.Unlock()
	t.Cleanup(func() {
		sourceCtrl.Close()
		targetCtrl.Close()
		tab.releaseSessionLease()
		detachedTarget.releaseSessionLease()
	})

	// 真实 UI 的"切换出去再点回来"走 openTopicTabPreferLiveActivation 的
	// promote 分支（复用 detached runtime 而非重新构建），这正是补命名的
	// 插入点。直接用该入口切回，验证补命名生效。
	if _, err := app.openTopicTabPreferLiveActivation("global", "", "topic-detached", targetPath, true); err != nil {
		t.Fatalf("open topic back: %v", err)
	}
	// promote 分支会新建/复用 detached 运行时对应的 tab 并从
	// detachedSessions 移除；验证确实走了该分支。
	app.mu.RLock()
	promoted := app.tabs[detachedRuntimeTabID(sessionRuntimeKey(targetPath))]
	stillDetached := app.detachedSessions[sessionRuntimeKey(targetPath)]
	app.mu.RUnlock()
	if stillDetached != nil {
		t.Fatalf("detached runtime was not promoted: %v", stillDetached)
	}
	if promoted == nil || promoted.Ctrl != targetCtrl {
		t.Fatalf("promoted tab Ctrl = %v, want detached target %p", promoted, targetCtrl)
	}
	if promoted.TopicTitle != topicTitleFromText("debug the payment webhook retry storm") {
		t.Fatalf("promoted tab TopicTitle = %q, want auto title", promoted.TopicTitle)
	}

	// The write went through the same root maybeAutoTitleTopic derives from
	// the global-scope tab (titleRoot = "").
	got := loadTopicTitle("", "topic-detached")
	want := topicTitleFromText("debug the payment webhook retry storm")
	if got != want {
		t.Fatalf("topic title after reattach = %q, want %q", got, want)
	}
	if tab.topicTitleSource != topicTitleSourceAuto {
		t.Fatalf("tab topic source after reattach = %q, want auto", tab.topicTitleSource)
	}
}

// TestAIRenameSessionUpdatesTopicTitle: the topic layer (state store) must
// reflect the new title after AIRenameSession, otherwise the sidebar topic
// label never changes.
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
