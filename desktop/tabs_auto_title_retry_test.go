package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/agent"
)

// 会话自动命名只在 topic 层提交成功后写 sidecar；那次写失败仅 Warn 一次且
// AutoMeta 去重挡住全部重试，per-session 标题便永远停留「新的会话」。修复：
// 命名已提交过时检查 sidecar 占位并补写（实际写在 caller 的 commitAutoTopicTitle）。

func autoTitleRetryWriteSession(t *testing.T, dir string, lines ...string) string {
	t.Helper()
	sessionPath := filepath.Join(dir, "session-retry.jsonl")
	if err := os.WriteFile(sessionPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}
	return sessionPath
}

func autoTitleRetrySidecarTitle(t *testing.T, sessionPath string) string {
	t.Helper()
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil {
		t.Fatalf("load sidecar: %v", err)
	}
	if !ok {
		return ""
	}
	return strings.TrimSpace(meta.TopicTitle)
}

// 场景 1：命名已提交（AutoMeta 记录在案）但 sidecar 停留占位名（当年写失败的
// 存量坏数据）→ 下一次 autosave 补写 sidecar，之后收敛为 no-op。
func TestAutoTitleRetryRewritesPlaceholderSidecar(t *testing.T) {
	isolateDesktopUserDirs(t)

	app := NewApp()
	projectRoot := t.TempDir()
	topic, err := app.CreateTopic("project", projectRoot, "")
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	sessionPath := autoTitleRetryWriteSession(t, t.TempDir(), `{"role":"user","content":"讲讲这个代码库的架构"}`)

	title, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath)
	if !updated || title != "讲讲这个代码库的架构" {
		t.Fatalf("first auto title = %q updated=%v, want 讲讲这个代码库的架构/true", title, updated)
	}
	// 模拟当年的 sidecar 写失败：topic 层已命名，但 commitAutoTopicTitle 未生效，
	// sidecar 保持占位名/不存在。
	if got := autoTitleRetrySidecarTitle(t, sessionPath); got != "" {
		t.Fatalf("fresh session unexpectedly has sidecar title %q", got)
	}

	// 第二次 autosave：shouldApply=false（同 stage 同 hash），sidecar 未同步 →
	// 必须再次给出补写信号。
	title, updated = autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath)
	if !updated || title != "讲讲这个代码库的架构" {
		t.Fatalf("retry auto title = %q updated=%v, want 讲讲这个代码库的架构/true", title, updated)
	}
	app.commitAutoTopicTitle(sessionPath, topic.ID, title)
	if got := autoTitleRetrySidecarTitle(t, sessionPath); got != title {
		t.Fatalf("sidecar title after retry commit = %q, want %q", got, title)
	}

	// 第三次 autosave：sidecar 已同步 → no-op。
	if _, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath); updated {
		t.Fatal("third pass should be a no-op once the sidecar is synced")
	}
}

// 场景 2：sidecar 已有真名（commitAutoTopicTitle 成功过的正常路径）→ 不得重复
// 提交。
func TestAutoTitleRetryKeepsSyncedSidecar(t *testing.T) {
	isolateDesktopUserDirs(t)

	app := NewApp()
	projectRoot := t.TempDir()
	topic, err := app.CreateTopic("project", projectRoot, "")
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	sessionPath := autoTitleRetryWriteSession(t, t.TempDir(), `{"role":"user","content":"讲讲这个代码库的架构"}`)

	title, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath)
	if !updated {
		t.Fatal("first auto title should update")
	}
	app.commitAutoTopicTitle(sessionPath, topic.ID, title)
	if got := autoTitleRetrySidecarTitle(t, sessionPath); got != "讲讲这个代码库的架构" {
		t.Fatalf("sidecar title = %q, want the committed name", got)
	}
	if _, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath); updated {
		t.Fatal("synced sidecar must not trigger another commit")
	}
}

// 场景 3：会话手动改名（CustomTitle）→ autoTitleTopicFromSession 上游的手动名
// 防线必须挡住补写，auto 名不得覆盖手动命名。
func TestAutoTitleRetryDoesNotTouchManuallyNamedSession(t *testing.T) {
	isolateDesktopUserDirs(t)

	app := NewApp()
	projectRoot := t.TempDir()
	topic, err := app.CreateTopic("project", projectRoot, "")
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	sessionPath := autoTitleRetryWriteSession(t, t.TempDir(), `{"role":"user","content":"讲讲这个代码库的架构"}`)

	title, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath)
	if !updated {
		t.Fatal("first auto title should update")
	}
	_ = title
	app.commitAutoTopicTitle(sessionPath, topic.ID, "讲讲这个代码库的架构")

	// 用户手动改名（session 粒度 CustomTitle）。
	if err := agent.UpdateBranchMeta(sessionPath, false, func(meta *agent.BranchMeta) error {
		meta.CustomTitle = "我的手动命名"
		return nil
	}); err != nil {
		t.Fatalf("set custom title: %v", err)
	}
	if _, updated := autoTitleTopicFromSession(projectRoot, topic.ID, sessionPath); updated {
		t.Fatal("manually named session must not re-trigger the auto title commit")
	}
	if got := autoTitleRetrySidecarTitle(t, sessionPath); got != "讲讲这个代码库的架构" {
		t.Fatalf("sidecar topic title = %q, want the auto name untouched by the custom title", got)
	}
}
