package agent

import (
	"testing"

	"reasonix/internal/provider"
)

// fresh 判定要复用生产判据，避免测试自己重写一套等式而与实现漂移。
func branchMetaFresh(m BranchMeta) bool {
	return sessionListingProjectionFresh(m.SchemaVersion, m.Turns, m.Revision,
		m.ListingRevision, m.ContentDigest, m.ListingContentDigest)
}

// 活跃会话在一次工具检查点后必须保持列表投影可信。检查点延迟的是昂贵的
// display index 重建，不该连带延迟 meta 的计数投影：一旦 meta 自认不可信，
// catalog 就会把这条「正在使用」的会话当成待修复的历史会话，反复排入修复
// 队列又抢不到前台写锁（busy），在 UI 上持续报「正在修复历史记录」。
func TestToolCheckpointKeepsListingProjectionFresh(t *testing.T) {
	path := schemaOneSessionPath(t, "session.jsonl")
	s := NewSession("system")
	s.Add(provider.Message{Role: provider.RoleUser, Content: "task"})
	bindSessionWriter(t, s, path)
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatal(err)
	}
	before, ok, err := LoadBranchMeta(path)
	if err != nil || !ok {
		t.Fatalf("LoadBranchMeta: ok=%v err=%v", ok, err)
	}
	if !branchMetaFresh(before) {
		t.Fatalf("夹具无效：初始投影应可信 %+v", before)
	}

	// 长跑会话会连续发生多次检查点；每一次之后投影都必须可信，否则
	// 「正在使用的会话」会在整段工具执行期间一直被判为待修复。
	for i := range 3 {
		id := string(rune('1' + i))
		s.AddBatch(
			provider.Message{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: id, Name: "write_file", Arguments: `{}`}}},
			provider.Message{Role: provider.RoleTool, ToolCallID: id, Name: "write_file", Content: "done", ToolRunState: provider.ToolRunCompleted},
		)
		if err := s.SaveToolCheckpoint(path, false); err != nil {
			t.Fatal(err)
		}
		at, ok, err := LoadBranchMeta(path)
		if err != nil || !ok {
			t.Fatalf("第 %d 次检查点后 LoadBranchMeta: ok=%v err=%v", i+1, ok, err)
		}
		if !branchMetaFresh(at) {
			t.Fatalf("第 %d 次工具检查点后列表投影不可信（会被判为待修复的历史会话）：schema=%d revision=%d listingRevision=%d",
				i+1, at.SchemaVersion, at.Revision, at.ListingRevision)
		}
		if at.SchemaVersion != BranchMetaCountsVersion {
			t.Fatalf("第 %d 次检查点计数投影版本未发布：schema=%d want=%d", i+1, at.SchemaVersion, BranchMetaCountsVersion)
		}
	}

	// display index 仍应留给后续正常快照重建：延迟语义只收敛到计数投影。
	if s.snapshotUpToDate(path) {
		t.Fatal("检查点不应让 display index 自认已是最新")
	}
}
