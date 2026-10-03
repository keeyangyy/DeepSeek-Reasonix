package agent

import (
	"fmt"
	"path/filepath"
	"testing"

	"reasonix/internal/provider"
)

// 行为守卫：持有效写入权的会话，在磁盘 leaf 被推进之后继续保存，**当前实现**不会把
// 它判成另一写者（不产生 recovery 分叉）。注意这与「另写者误判」调研的预期相反 ——
// 该调研认为 DAG 路径漏看写入权（对照 save.go:537 的 ownsWritableBaseline），但本构造
// 未能复现误判，缺口存在性存疑。此测试固定现有行为，供后续改动时对照。
func TestDAGSaveWithValidAuthorityDoesNotForkAfterForeignAdvance(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	s := NewSession("sys")
	s.Add(provider.Message{Role: provider.RoleUser, Content: "u0"})
	s.Add(provider.Message{Role: provider.RoleAssistant, Content: "a0"})
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("initial save: %v", err)
	}

	// 磁盘被推进：模拟交接期间由另一次保存把 head 的 leaf 前移（append 不改 head）。
	advancer := NewSession("sys")
	advancer.Add(provider.Message{Role: provider.RoleUser, Content: "u0"})
	advancer.Add(provider.Message{Role: provider.RoleAssistant, Content: "a0"})
	advancer.Add(provider.Message{Role: provider.RoleUser, Content: "u-other"})
	advancer.Add(provider.Message{Role: provider.RoleAssistant, Content: "a-other"})
	if err := advancer.SaveSnapshot(path); err != nil {
		t.Fatalf("advance save: %v", err)
	}
	loaded, err := LoadSession(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.head.ref.LeafID == s.head.ref.LeafID {
		t.Fatalf("fixture 未命中：advancer 推进磁盘后 s 的位置记录仍然一致（leaf=%q）", s.head.ref.LeafID)
	}

	lease, err := TryAcquireSessionLease(path)
	if err != nil {
		t.Fatalf("lease: %v", err)
	}
	defer lease.Release()
	auth, err := lease.IssueWriteAuthority(NextSessionWriteGeneration())
	if err != nil {
		t.Fatalf("authority: %v", err)
	}
	s.BindWriteAuthority(auth)
	if !s.hasValidWriteAuthority(path) {
		t.Fatal("fixture: 此处应当持有覆盖该路径的有效写入权")
	}

	// 会话继续自己的内容并保存：它有权，所以这是自己的改写，不该判成别人的分叉。
	s.Add(provider.Message{Role: provider.RoleUser, Content: fmt.Sprintf("u%d", 1)})
	s.Add(provider.Message{Role: provider.RoleAssistant, Content: "a1"})
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("authority save: %v", err)
	}
	if got := recoveryJSONL(dir); len(got) != 0 {
		t.Fatalf("持有效写入权却被判成另一写者，分叉出 %v", got)
	}
}
