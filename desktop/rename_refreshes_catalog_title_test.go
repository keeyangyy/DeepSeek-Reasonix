package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/provider"
	"reasonix/internal/sessioncatalog"
)

// TestRenameTopicRefreshesCatalogTitlePromptly 守护"重命名生效但列表标题延迟
// 更新"：RenameTopic 对 sidecar 齐全（changedDirs 非空）的 topic 走 reconcile
// 分支时，必须同时触发 metadata sync——catalog_topics.title 只由 SyncMetadata
// 写入，缺了它前端列表标题要等 30s 清扫才修正（修复前 3s 内读不到新标题）。
func TestRenameTopicRefreshesCatalogTitlePromptly(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := t.TempDir()
	if err := addProject(root, "Rename Project"); err != nil {
		t.Fatal(err)
	}
	const topicID = "rename-refresh-topic"
	// ensureTopicIndexed 同时注册 project.Topics 与 titles，保证 metadata
	// sync 后 catalog_topics 有该 topic 行（真实新会话首次索引路径）。
	if err := ensureTopicIndexed("project", root, topicID, "Old title", topicTitleSourceManual); err != nil {
		t.Fatal(err)
	}
	sessionDir := desktopSessionDir(root)
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(sessionDir, "session.jsonl")
	session := agent.NewSession("sys")
	session.Add(provider.Message{Role: provider.RoleUser, Content: "hello"})
	session.Add(provider.Message{Role: provider.RoleAssistant, Content: "hi"})
	if err := session.Save(path); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveBranchMetaPreserveUpdated(path, agent.BranchMeta{
		ID: agent.BranchID(path), Scope: "project", WorkspaceRoot: root, TopicID: topicID,
		TopicTitle: "Old title",
	}); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	installSessionCatalogForTest(t, app, sessionDir, "project", root)
	// 先同步一次 metadata，让 catalog_topics 有该 topic 行（标题 Old title）。
	catalog := app.sessionCatalog.Load()
	if err := app.syncSessionCatalogMetadata(context.Background(), catalog); err != nil {
		t.Fatalf("seed syncSessionCatalogMetadata: %v", err)
	}
	if topic, ok, err := catalog.GetTopic(context.Background(), sessioncatalog.TopicKey{Scope: "project", WorkspaceRoot: normalizeProjectRoot(root), TopicID: topicID}); err != nil || !ok {
		t.Fatalf("seed GetTopic(%s) = ok=%v err=%v; catalog row missing (project.Topics=%v titles=%v)",
			topicID, ok, err, loadProjectsFile().Projects[0].Topics, loadTopicTitles(root))
	} else if topic.Title != "Old title" {
		t.Fatalf("seed GetTopic title = %q, want Old title", topic.Title)
	}
	if page, err := app.ListProjectTopics(ProjectTopicPageRequest{Scope: "project", WorkspaceRoot: root, Limit: 50}); err != nil {
		t.Fatalf("ListProjectTopics before rename: %v", err)
	} else if pageLabel(page, topicID) != "Old title" {
		status := catalog.Status()
		t.Fatalf("seed: topic label = %q, want %q (catalog state=%s rev=%d indexed=%d; page items=%d: %s)",
			pageLabel(page, topicID), "Old title", status.State, status.Revision, status.Indexed, len(page.Items), pageItemLabels(page))
	}

	if err := app.RenameTopic(topicID, "Renamed title"); err != nil {
		t.Fatalf("RenameTopic: %v", err)
	}

	// 守护点：catalog_topics.title 只由 SyncMetadata 写入，重命名走
	// reconcile 分支时必须同时触发 metadata sync，否则列表标题等 30s
	// 清扫才更新（session overlay 兜底，不能用 ListProjectTopics 断言）。
	deadline := time.Now().Add(3 * time.Second)
	for {
		topic, ok, err := catalog.GetTopic(context.Background(), sessioncatalog.TopicKey{Scope: "project", WorkspaceRoot: normalizeProjectRoot(root), TopicID: topicID})
		if err != nil {
			t.Fatalf("GetTopic: %v", err)
		}
		if ok && strings.TrimSpace(topic.Title) == "Renamed title" {
			return // 修复后：metadata sync 立即写入 catalog_topics.title
		}
		if time.Now().After(deadline) {
			t.Fatalf("catalog_topics.title = %q within 3s after RenameTopic; want %q (reconcile-only path never updates topic titles)",
				func() string {
					if !ok {
						return "<missing>"
					}
					return topic.Title
				}(), "Renamed title")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func pageLabel(page ProjectTopicPage, topicID string) string {
	for _, node := range page.Items {
		if node.TopicID == topicID {
			return node.Label
		}
	}
	return "<not listed>"
}

func pageItemLabels(page ProjectTopicPage) string {
	out := make([]string, 0, len(page.Items))
	for _, node := range page.Items {
		out = append(out, node.TopicID+":"+node.Label)
	}
	return strings.Join(out, ", ")
}
