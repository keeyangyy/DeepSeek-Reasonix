package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"reasonix/internal/agent"
)

// 复现"topic 被脏 manual 污染后永久停留'新的会话'"：
// 真实用户数据（topic_20260919-093225）中 topic state 为 title=默认 + source=manual，
// 而 session 无 CustomTitle、无 .titles.json 记录——autoTitle 与切回 fallback 双双拒绝，
// 永久卡死。自愈：这种"默认标题 + manual + 无真实手动名"组合应视作未命名，允许补命名。
func TestRebuildBackfillsMissedAutoTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := globalTabWorkspaceRoot()
	dir := desktopSessionDir(root)

	sessionPath := filepath.Join(dir, "missed-rename.jsonl")
	writeHistoryTestSession(t, sessionPath, "帮我分析这个代码库的架构")
	topicID := "topic-missed-rename"
	// 脏状态：manual + 默认标题（无真实手动名）。
	if err := ensureTopicIndexedWithCreatedAt(
		"global", "", topicID, defaultTopicTitle, topicTitleSourceManual, time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("index topic: %v", err)
	}

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}
	app.projectTreeChangedHook = func() {}

	// detachedSessions 为空 → 必然走重建分支。
	meta, err := app.openTopicTabPreferLiveActivation("global", "", topicID, sessionPath, true)
	if err != nil {
		t.Fatalf("open topic: %v", err)
	}
	tab := waitForTabReady(t, app, meta.ID)
	if tab == nil {
		t.Fatalf("rebuilt tab never became ready")
	}

	want := topicTitleFromText("帮我分析这个代码库的架构")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := loadTopicTitle("", topicID); got != "" && got != defaultTopicTitle {
			if got != want {
				t.Fatalf("topic title = %q, want %q", got, want)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("topic title still %q after rebuild backfill window", loadTopicTitle("", topicID))
}

// project scope 版本：模拟用户真实工作区（D:/project/...）下的脏 manual 场景。
func TestRebuildBackfillsMissedAutoTitleProjectScope(t *testing.T) {
	isolateDesktopUserDirs(t)
	projectRoot := t.TempDir()

	dir := desktopSessionDir(normalizeProjectRoot(projectRoot))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir session dir: %v", err)
	}
	sessionPath := filepath.Join(dir, "missed-rename-project.jsonl")
	writeHistoryTestSession(t, sessionPath, "帮我分析这个代码库的架构")
	topicID := "topic-missed-project"
	normalized := normalizeProjectRoot(projectRoot)
	// 脏状态：manual + 默认标题（用户真实数据 topic_20260919-093225 的形态）。
	if err := ensureTopicIndexedWithCreatedAt(
		"project", normalized, topicID, defaultTopicTitle, topicTitleSourceManual, time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("index topic: %v", err)
	}

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}
	app.projectTreeChangedHook = func() {}

	meta, err := app.openTopicTabPreferLiveActivation("project", projectRoot, topicID, sessionPath, true)
	if err != nil {
		t.Fatalf("open topic: %v", err)
	}
	tab := waitForTabReady(t, app, meta.ID)
	if tab == nil {
		t.Fatalf("rebuilt tab never became ready")
	}

	want := topicTitleFromText("帮我分析这个代码库的架构")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := loadTopicTitle(normalized, topicID); got != "" && got != defaultTopicTitle {
			if got != want {
				t.Fatalf("topic title = %q, want %q", got, want)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("topic title still %q after rebuild (project scope)", loadTopicTitle(normalized, topicID))
}

// 真实手动命名必须保持 manual 保护：session 有 CustomTitle 时，脏自愈不得覆盖。
func TestManualProtectedTitleNotOverwritten(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := globalTabWorkspaceRoot()
	dir := desktopSessionDir(root)

	sessionPath := filepath.Join(dir, "manually-named.jsonl")
	writeHistoryTestSession(t, sessionPath, "帮我分析这个代码库的架构")
	// 模拟真实手动改名：写 CustomTitle（sessionHasManualDisplayTitle 的依据）。
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		t.Fatalf("load branch meta: ok=%v err=%v", ok, err)
	}
	meta.CustomTitle = "我的手工命名"
	if err := agent.SaveBranchMeta(sessionPath, meta); err != nil {
		t.Fatalf("save custom title: %v", err)
	}
	topicID := "topic-manual-real"
	if err := ensureTopicIndexedWithCreatedAt(
		"global", "", topicID, "我的手工命名", topicTitleSourceManual, time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("index topic: %v", err)
	}

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}
	app.projectTreeChangedHook = func() {}

	openMeta, err := app.openTopicTabPreferLiveActivation("global", "", topicID, sessionPath, true)
	if err != nil {
		t.Fatalf("open topic: %v", err)
	}
	tab := waitForTabReady(t, app, openMeta.ID)
	if tab == nil {
		t.Fatalf("rebuilt tab never became ready")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := loadTopicTitle("", topicID); got != "我的手工命名" {
			t.Fatalf("manual title was overwritten: %q", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
