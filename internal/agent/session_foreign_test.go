package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// 判据：本线给每个经手的会话都写归属（scope / workspace_root / topic_id），
// 另一线一个都不写。所以"归属全无"就是另一线，不必自造标记。
func TestIsForeignSessionReadsOwnership(t *testing.T) {
	dir := t.TempDir()
	withMeta := func(name, meta string) string {
		path := filepath.Join(dir, name+".jsonl")
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(BranchMetaPath(path), []byte(meta), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// 本线新建：pin 会写 scope + workspace_root，话题层会写 topic
	oursNew := withMeta("ours-new", `{"id":"a","scope":"project","workspace_root":"D:\\p","topic_id":"topic_1","topic_title":"标题"}`)
	// 本线早期会话：可能只有 scope
	oursScopeOnly := withMeta("ours-scope", `{"id":"b","scope":"global"}`)
	// 另一线的原始形态（实测样本：只有这 10 个字段）
	theirs := withMeta("theirs", `{"id":"c","created_at":"2026-10-04T11:48:29Z","model":"m","revision":2,`+
		`"content_digest":"9b","writer_id":"w","schema_version":2,"turns":1,"preview":"这是一个测试会话"}`)
	// 另一线分叉/归档过的会话
	theirsArchived := withMeta("theirs-archived", `{"id":"d","archived":true,"superseded":false}`)
	noSidecar := filepath.Join(dir, "bare.jsonl")
	if err := os.WriteFile(noSidecar, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if IsForeignSession(oursNew) {
		t.Fatal("本线会话（有归属）被判成了另一线")
	}
	if IsForeignSession(oursScopeOnly) {
		t.Fatal("本线会话（只有 scope）被判成了另一线")
	}
	if !IsForeignSession(theirs) {
		t.Fatal("另一线的原始会话（无任何归属）没被判出来")
	}
	if !IsForeignSession(theirsArchived) {
		t.Fatal("带 archived 的会话没被判出来")
	}
	if IsForeignSession(noSidecar) {
		t.Fatal("没有 sidecar 的会话不该被判成另一线")
	}
}
