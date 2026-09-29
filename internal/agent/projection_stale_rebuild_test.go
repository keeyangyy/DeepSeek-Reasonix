package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// 复现（2026-09-29「会话重复问题」实测）：历史被改写/重放导致投影内容失配后，
// 视图退回全量并每轮重放整个会话（实测 1092 条 / 5.6MB → 上游 400），即使估算
// 未到压缩线也不会自愈。修复后 stale 投影强制重建（绕过回退/卡住抑制）。
func TestStaleFoldForcesRebuildInsteadOfFullReplay(t *testing.T) {
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
	if a.projectionStaleForRebuild() {
		t.Fatal("fixture: 新建投影不应判为 stale")
	}

	// 覆盖指纹失配 = 历史被改写/重放后投影不再可信（稳定复现手法）。
	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.CoveredPrefixHash = "stale-covered-prefix"
	a.sess.compactionMu.Unlock()
	if !a.projectionStaleForRebuild() {
		t.Fatal("fixture: 指纹失配后应判为 stale")
	}

	// 自动请求准备必须重建投影，而不是让本轮重放整个会话。
	prov.got = nil
	prepared, err := a.contextManager().Prepare(context.Background(), ContextPreparePolicy{Trigger: CompactionTriggerPressure})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if len(prov.got) == 0 {
		t.Fatal("stale 投影未触发重建：本轮仍会重放整个会话")
	}
	if !hasCompactionSummary(prepared.Messages) {
		t.Fatal("重建后视图仍无摘要（回退到全量）")
	}
	if a.projectionStaleForRebuild() {
		t.Fatal("重建后投影仍判为 stale")
	}
}

// 投影有效（未 stale）时不得强制重建：普通 turn 不应多出压缩请求。
func TestFreshFoldDoesNotForceRebuild(t *testing.T) {
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
		ContextWindow: 200_000, CompactRatio: 0.8, RecentKeep: 2,
		WorkspaceID: "ws", ModelRef: "p/model-a",
	}, event.Discard)
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	prov.got = nil
	if _, err := a.contextManager().Prepare(context.Background(), ContextPreparePolicy{Trigger: CompactionTriggerPressure}); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if len(prov.got) != 0 {
		t.Fatalf("投影有效且未达触发线时产生了 %d 个压缩请求，want 0", len(prov.got))
	}
}
