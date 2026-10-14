package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/config"
	"reasonix/internal/control"
)

// A permanent topic removal deletes the session files in place; it must not
// publish a recoverable trash entry, and it still clears topic metadata.
func TestPurgeTopicRemovesSessionFilesWithoutTrashEntry(t *testing.T) {
	isolateDesktopUserDirs(t)
	projectRoot := t.TempDir()
	topicID := "topic_purge_permanent"
	if err := addProject(projectRoot, ""); err != nil {
		t.Fatalf("add project: %v", err)
	}
	if err := setTopicTitle(projectRoot, topicID, "Purge me"); err != nil {
		t.Fatalf("set topic title: %v", err)
	}
	dir := config.SessionDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	sessionPath := writeTopicSessionWithPrompt(t, dir, "purge-me.jsonl", topicID, "Purge me", projectRoot, "delete me", time.Now())

	app := NewApp()
	if err := app.PurgeTopic(topicID); err != nil {
		t.Fatalf("PurgeTopic: %v", err)
	}
	if _, err := os.Stat(sessionPath); !os.IsNotExist(err) {
		t.Fatalf("purged session still on disk: %v", err)
	}
	if agent.IsCleanupPending(sessionPath) {
		t.Fatal("purge left a cleanup-pending marker behind")
	}
	trashed, err := listTrashedSessionFiles(dir)
	if err != nil {
		t.Fatalf("listTrashedSessionFiles: %v", err)
	}
	if len(trashed) != 0 {
		t.Fatalf("purge published trash entries: %v", trashed)
	}
	if _, err := os.Stat(filepath.Join(sessionTrashPath(dir), filepath.Base(sessionPath))); !os.IsNotExist(err) {
		t.Fatalf("purge created a trash item directory: %v", err)
	}
	if got := loadTopicTitle(projectRoot, topicID); got != "" {
		t.Fatalf("purged topic title = %q, want empty", got)
	}
	if _, err := os.Stat(topicArchiveMetadataPendingPath(topicID)); !os.IsNotExist(err) {
		t.Fatalf("purge retained the topic metadata marker: %v", err)
	}
}

// The session-level permanent path mirrors DeleteSession's runtime teardown but
// deletes the file instead of moving it to the trash.
func TestPurgeSessionRemovesFileWithoutTrashEntry(t *testing.T) {
	isolateDesktopUserDirs(t)
	dir := config.SessionDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	path := filepath.Join(dir, "purge-session.jsonl")
	if err := os.WriteFile(path, []byte(`{"role":"user","content":"hello"}`+"\n"), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}

	app := NewApp()
	ctrl := control.New(control.Options{SessionDir: dir, SessionPath: path, Label: "purge"})
	defer ctrl.Close()
	app.setTestCtrl(ctrl, "")
	keepPath := filepath.Join(dir, "purge-keep.jsonl")
	if err := os.WriteFile(keepPath, []byte(`{"role":"user","content":"keep"}`+"\n"), 0o644); err != nil {
		t.Fatalf("write keep session: %v", err)
	}
	keepCtrl := control.New(control.Options{SessionDir: dir, SessionPath: keepPath, Label: "keep"})
	defer keepCtrl.Close()
	app.tabs["keep"] = &WorkspaceTab{ID: "keep", Scope: "global", Ctrl: keepCtrl, Ready: true}
	app.tabOrder = []string{"test", "keep"}

	if err := app.PurgeSession(filepath.Base(path)); err != nil {
		t.Fatalf("PurgeSession: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("purged session still on disk: %v", err)
	}
	trashPath := filepath.Join(dir, sessionTrashDir, "purge-session.jsonl")
	if _, err := os.Stat(trashPath); !os.IsNotExist(err) {
		t.Fatalf("purge created a trash item: %v", err)
	}
	if agent.IsCleanupPending(path) {
		t.Fatal("purge left a cleanup-pending marker behind")
	}
}
