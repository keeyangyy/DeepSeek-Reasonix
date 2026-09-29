package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// 复现（2026-09-29「会话重复问题」实测）：压缩后的会话在运行中切换模型 →
// lineage key 变化 → modelVisibleMessages 静默回退全量 canonical 历史
// （实测 1092 条 / 5.6MB → 上游 400），而投影体其实仍与 canonical 前缀一致。
// 修复后应重签 lineage 并继续使用折叠视图。
func TestModelSwitchRebindsProjectionInsteadOfFullHistory(t *testing.T) {
	prov := &recordingProvider{reply: "digest"}
	long := strings.Repeat("old work ", 400)
	sess := &Session{Messages: []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "task"},
		{Role: provider.RoleAssistant, Content: long},
		{Role: provider.RoleUser, Content: "continue"},
		{Role: provider.RoleAssistant, Content: long},
		{Role: provider.RoleUser, Content: "tail"},
		{Role: provider.RoleAssistant, Content: "ok"},
	}}
	a := New(prov, tool.NewRegistry(), sess, Options{
		ContextWindow: 50_000, CompactRatio: 0.5, RecentKeep: 2,
		WorkspaceID: "ws", ModelRef: "p/model-a",
	}, event.Discard)

	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	total := len(sess.Messages)
	if folded := a.modelVisibleMessages(); len(folded) >= total || !hasCompactionSummary(folded) {
		t.Fatalf("压缩后投影未生效：visible=%d total=%d", len(folded), total)
	}

	// 运行中切换模型：lineage key 变化，但投影体仍与前缀一致。
	a.modelRef = "p/model-b"
	visible := a.modelVisibleMessages()
	if len(visible) >= total {
		t.Fatalf("切模型后回退全量（visible=%d total=%d）：应重签投影 lineage 而非静默发全量历史", len(visible), total)
	}
	if !hasCompactionSummary(visible) {
		t.Fatal("切模型后投影摘要丢失")
	}
	if key := a.currentPromptCacheKey(); !strings.Contains(key, "model-b") {
		t.Fatalf("重签后 lineage key = %q, want 含 model-b", key)
	}
}

// 内容失配仍必须 fail closed：投影体与 canonical 前缀不一致（历史被编辑）时
// 不得重签复用，只能回退 canonical。
func TestLineageRebindFailsClosedOnContentMismatch(t *testing.T) {
	prov := &recordingProvider{reply: "digest"}
	long := strings.Repeat("old work ", 400)
	sess := &Session{Messages: []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "task"},
		{Role: provider.RoleAssistant, Content: long},
		{Role: provider.RoleUser, Content: "continue"},
		{Role: provider.RoleAssistant, Content: long},
		{Role: provider.RoleUser, Content: "tail"},
		{Role: provider.RoleAssistant, Content: "ok"},
	}}
	a := New(prov, tool.NewRegistry(), sess, Options{
		ContextWindow: 50_000, CompactRatio: 0.5, RecentKeep: 2,
		WorkspaceID: "ws", ModelRef: "p/model-a",
	}, event.Discard)
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	total := len(sess.Messages)

	// 内容失配（指纹不再匹配 canonical 前缀，等价于历史被编辑）→ 不得重签。
	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.CoveredPrefixHash = "stale-covered-prefix"
	a.sess.compactionMu.Unlock()
	a.modelRef = "p/model-b"
	if visible := a.modelVisibleMessages(); len(visible) != total {
		t.Fatalf("内容失配时 visible=%d，want 回退全量 %d", len(visible), total)
	}
}
