package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// 换模型（或换工作区）只改变身份，不改变投影覆盖的那段历史 —— 投影必须继续被使用，
// 而不是退回发送完整正史（实测 1092 条 / 5.6MB → 上游 400）。只有覆盖的那段历史真的
// 变了，才允许丢投影。
func TestModelSwitchKeepsProjectionInsteadOfFullReplay(t *testing.T) {
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
	full := len(sess.Snapshot())
	if visible := a.modelVisibleMessages(); len(visible) >= full {
		t.Fatalf("fixture: 压缩后视图应短于全量：visible=%d full=%d", len(visible), full)
	}

	// 换成另一个模型：身份变了，历史没变 —— 投影照用。
	a.modelRef = "p/model-b"
	visible := a.modelVisibleMessages()
	if len(visible) >= full {
		t.Fatalf("换模型后回退到完整正史：visible=%d full=%d", len(visible), full)
	}
	if !hasCompactionSummary(visible) {
		t.Fatal("换模型后视图里没有摘要（投影被丢弃了）")
	}

	// 覆盖的那段历史真的变了，才允许丢投影、退回全量。
	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.CoveredPrefixHash = "stale-covered-prefix"
	a.sess.compactionMu.Unlock()
	if got := a.modelVisibleMessages(); len(got) != full {
		t.Fatalf("覆盖区历史被改后应回退全量：got=%d full=%d", len(got), full)
	}
}
