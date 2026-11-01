package main

import "testing"

// 复现侧栏重复条目的一个候选来源：同一个会话同时存在于 a.tabs（可见标签）
// 与 a.detachedSessions（切走后保留的运行时），且两处携带不同的 topicID。
// catalogRuntimeSnapshots 会分别采集这两条快照，runtimeProjectTopicNodes 再按
// topicID 分组，于是同一个会话被投影成两个节点 —— 侧栏出现两行同名条目。
func TestRuntimeProjectTopicNodesCollapseSameSessionAcrossTabsAndDetached(t *testing.T) {
	app := NewApp()
	path := "/sessions/shared-conversation.jsonl"

	app.tabs["t1"] = &WorkspaceTab{
		ID: "t1", Scope: "global", TopicID: "topic_new",
		SessionPath: path, TopicTitle: "你好",
	}
	app.detachedSessions[sessionRuntimeKey(path)] = &WorkspaceTab{
		ID: "t2", Scope: "global", TopicID: "topic_old",
		SessionPath: path, TopicTitle: "你好",
	}

	nodes, sessionsByTopic := app.runtimeOnlyProjectTopicsWithSessions("global", "")
	if len(nodes) != 1 {
		ids := make([]string, 0, len(nodes))
		for _, n := range nodes {
			ids = append(ids, n.TopicID+"("+n.Label+")")
		}
		t.Fatalf("同一会话产出 %d 个运行时节点（want 1）：%v；sessionsByTopic=%v", len(nodes), ids, sessionsByTopic)
	}
}

// 同一会话在 a.tabs 与 a.detachedSessions 里 topicID 相同的情况：
// 这是正常交接，节点必须仍然只有一个。
func TestRuntimeProjectTopicNodesCollapseSameTopicAcrossTabsAndDetached(t *testing.T) {
	app := NewApp()
	path := "/sessions/same-topic.jsonl"

	app.tabs["t1"] = &WorkspaceTab{
		ID: "t1", Scope: "global", TopicID: "topic_same",
		SessionPath: path, TopicTitle: "你好",
	}
	app.detachedSessions[sessionRuntimeKey(path)] = &WorkspaceTab{
		ID: "t2", Scope: "global", TopicID: "topic_same",
		SessionPath: path, TopicTitle: "你好",
	}

	nodes, _ := app.runtimeOnlyProjectTopicsWithSessions("global", "")
	if len(nodes) != 1 {
		t.Fatalf("同 topicID 的同一会话产出 %d 个节点（want 1）：%+v", len(nodes), nodes)
	}
}

// 不同会话即使标题相同，也必须各自成行 —— 修复不能误合并用户真实的两条对话。
func TestRuntimeProjectTopicNodesKeepDistinctSessionsWithSameTitle(t *testing.T) {
	app := NewApp()

	app.tabs["t1"] = &WorkspaceTab{
		ID: "t1", Scope: "global", TopicID: "topic_a",
		SessionPath: "/sessions/a.jsonl", TopicTitle: "你好",
	}
	app.tabs["t2"] = &WorkspaceTab{
		ID: "t2", Scope: "global", TopicID: "topic_b",
		SessionPath: "/sessions/b.jsonl", TopicTitle: "你好",
	}

	nodes, _ := app.runtimeOnlyProjectTopicsWithSessions("global", "")
	if len(nodes) != 2 {
		t.Fatalf("两个不同会话产出 %d 个节点（want 2）：%+v", len(nodes), nodes)
	}
}
