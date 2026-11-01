package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"reasonix/internal/provider"
	"reasonix/internal/store"
)

func userMsg(text string) provider.Message {
	return provider.Message{Role: provider.RoleUser, Content: text}
}

func assistantMsg(text string) provider.Message {
	return provider.Message{Role: provider.RoleAssistant, Content: text}
}

// 压缩开始时对话进行到第 14 轮，但折叠只覆盖前 6 轮：锚点必须记 14，而不是 6。
// 记 6 会让重启后的卡片往前跳一大段（压缩后继续聊的那些轮次全被绕过）。
func TestCompactionAnchorPrefersStartSnapshot(t *testing.T) {
	dir := t.TempDir()
	sessionPath := filepath.Join(dir, "s.jsonl")

	writeCompactionSidecar(sessionPath, "marker", &CompactionRecord{AnchorUserMessages: 14})
	if got := compactionMarkerAnchor(sessionPath); got != 14 {
		t.Fatalf("marker anchor = %d, want 14", got)
	}

	canonical := []provider.Message{
		userMsg("q1"), assistantMsg("a1"),
		userMsg("q2"), assistantMsg("a2"),
		userMsg("q3"), assistantMsg("a3"),
		userMsg("q4"), assistantMsg("a4"),
		userMsg("q5"), assistantMsg("a5"),
		userMsg("q6"), assistantMsg("a6"),
		userMsg("q7"), assistantMsg("a7"),
	}
	covered := 12 // 只折叠前 6 轮

	if got := compactionAnchorForRecord(canonical, covered, sessionPath); got != 14 {
		t.Fatalf("anchor = %d, want 14 (start snapshot wins over folded prefix)", got)
	}

	// 快照缺失时回退到折叠前缀的轮数，保证旧 marker 仍可读。
	writeCompactionSidecar(sessionPath, "clear", nil)
	if got := compactionAnchorForRecord(canonical, covered, sessionPath); got != 6 {
		t.Fatalf("fallback anchor = %d, want 6", got)
	}
}

// 完成压缩后 marker 会被清掉，记录本身要能独立表达位置。
func TestCompactionRecordKeepsAnchorAfterMarkerCleared(t *testing.T) {
	dir := t.TempDir()
	sessionPath := filepath.Join(dir, "s.jsonl")

	anchor := 14
	if got := compactionAnchorForRecord(nil, 0, sessionPath); got != 0 {
		t.Fatalf("无 marker 无 folded 前缀时 anchor = %d, want 0", got)
	}
	writeCompactionSidecar(sessionPath, "marker", &CompactionRecord{AnchorUserMessages: anchor})
	rec := &CompactionRecord{Trigger: "manual", AnchorUserMessages: compactionAnchorForRecord(nil, 0, sessionPath)}
	writeCompactionSidecar(sessionPath, "record", rec)

	// marker 已随 record 一起清掉，落盘记录必须自带 anchor。
	if compactionMarkerAnchor(sessionPath) != 0 {
		t.Fatalf("record 写入后 marker 应已清除")
	}
	b, err := os.ReadFile(filepath.Join(store.SessionCheckpointDir(sessionPath), "latest-compaction.json"))
	if err != nil {
		t.Fatalf("读取 sidecar 记录失败: %v", err)
	}
	var got CompactionRecord
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("解析 sidecar 记录失败: %v", err)
	}
	if got.AnchorUserMessages != anchor {
		t.Fatalf("落盘 anchor = %d, want %d", got.AnchorUserMessages, anchor)
	}
}
