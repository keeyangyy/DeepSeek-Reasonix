package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// 复现（2026-09-29「会话重复问题」实测）：估算 memo 的 key 不含 session/model
// lineage，切模型后视图已从折叠变回全量，而表盘仍报告旧折叠值（UI 显示
// 300+k、实际发送 5.6MB）。修复后 lineage 变即失效重算。
func TestContextUsedTokensRefreshesWhenLineageChanges(t *testing.T) {
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
	folded := a.ContextUsedTokens()
	if folded <= 0 {
		t.Fatalf("折叠视图估算 = %d，want > 0", folded)
	}

	// 投影内容失配（历史被改写）+ 切模型：视图退回全量。
	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.CoveredPrefixHash = "stale-covered-prefix"
	a.sess.compactionMu.Unlock()
	a.modelRef = "p/model-b"

	if full := a.ContextUsedTokens(); full <= folded {
		t.Fatalf("lineage 变化后估算未刷新：folded=%d full=%d（memo key 未纳入 lineage）", folded, full)
	}
}
