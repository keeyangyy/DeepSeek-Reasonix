package agent

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// fallbackNotices returns the projection-fallback notices a run recorded. A
// fixture that compacts also emits notices of its own, so tests compare counts
// rather than assuming the sink started empty.
func fallbackNotices(s *recordSink) []event.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []event.Event
	for _, e := range s.evs {
		if e.Kind == event.Notice && strings.Contains(e.Detail, "projection=") {
			out = append(out, e)
		}
	}
	return out
}

func fallbackFixture(t *testing.T, sink *recordSink) *Agent {
	t.Helper()
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
	}, sink)
	if err := a.compact(context.Background(), CompactionTriggerManual, "", true); err != nil {
		t.Fatalf("compact: %v", err)
	}
	return a
}

// 投影失效而回退全量时必须留痕：以前完全静默，只在收到 400 才发现，且看不出是
// 哪条判定挂的。这里用「覆盖指纹失配」这一稳定复现手法断言通知与原因。
func TestProjectionFallbackEmitsNoticeWithReason(t *testing.T) {
	sink := &recordSink{}
	a := fallbackFixture(t, sink)
	before := len(fallbackNotices(sink))

	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.CoveredPrefixHash = "stale-covered-prefix"
	a.sess.compactionMu.Unlock()

	visible := a.modelVisibleMessages()
	if hasCompactionSummary(visible) {
		t.Fatal("fixture: 指纹失配后本应回退全量（视图里不该有摘要）")
	}
	notices := fallbackNotices(sink)
	if len(notices) <= before {
		t.Fatal("投影失效回退全量时没有新增 notice（这一路径仍是静默的）")
	}
	last := notices[len(notices)-1]
	if !strings.Contains(last.Detail, "projection=covered_prefix_mismatch") {
		t.Errorf("notice 未带失效原因，实际 detail=%q", last.Detail)
	}
	if !strings.Contains(last.Detail, "messages=") {
		t.Errorf("notice 未带消息条数，实际 detail=%q", last.Detail)
	}
	if last.Text == "" {
		t.Error("notice 文案为空")
	}
}

// 投影有效时这项回退通知不得新增：否则每个普通 turn 都会多一条噪声。
func TestFreshProjectionDoesNotEmitFallbackNotice(t *testing.T) {
	sink := &recordSink{}
	a := fallbackFixture(t, sink)
	before := len(fallbackNotices(sink))

	if visible := a.modelVisibleMessages(); !hasCompactionSummary(visible) {
		t.Fatal("fixture: 新投影应被使用（视图里应有摘要）")
	}
	if after := len(fallbackNotices(sink)); after != before {
		t.Fatalf("投影有效却在这次调用里新增了 %d 条回退通知", after-before)
	}
}

// 从未折叠过的会话不算事故：什么都没丢，报出来只会淹没真信号。
func TestProjectionFallbackStaysQuietBeforeFirstFold(t *testing.T) {
	sink := &recordSink{}
	a := fallbackFixture(t, sink)
	before := len(fallbackNotices(sink))

	a.sess.compactionMu.Lock()
	a.sess.compactionState.Projection.Messages = nil
	a.sess.compactionMu.Unlock()

	a.modelVisibleMessages()
	if after := len(fallbackNotices(sink)); after != before {
		t.Fatalf("未折叠的会话不该发回退通知，新增 %d 条", after-before)
	}
}
