package main

import (
	"os"
	"path/filepath"
	"testing"

	"reasonix/internal/store"
)

// 分叉（fork）出来的会话会复制原会话的 sidecar 目录。新路径读不到记录的话，
// 分叉后一重启压缩卡片就消失——这条路径是用户实际在用的，必须有测试兜底。
func TestLatestCompactionSurvivesForkedSession(t *testing.T) {
	dir := t.TempDir()
	original := filepath.Join(dir, "original.jsonl")
	if err := os.WriteFile(original, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed original session: %v", err)
	}
	writeCompactionSidecar(t, original, map[string]any{
		"trigger": "manual", "messages": 39, "summary": "s", "anchorUserMessages": 14,
	}, -1)

	// fork：会话文件另存一份，sidecar 目录整份复制过去
	forked := filepath.Join(dir, "forked.jsonl")
	if err := os.WriteFile(forked, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed forked session: %v", err)
	}
	copySidecarDir(t, store.SessionCheckpointDir(original), store.SessionCheckpointDir(forked))

	view, err := latestCompactionForSession(forked)
	if err != nil {
		t.Fatalf("read forked sidecar: %v", err)
	}
	if view == nil {
		t.Fatalf("分叉会话读不到压缩记录（重启后卡片会消失）")
	}
	if view.AnchorUserMessages != 14 {
		t.Fatalf("分叉会话锚点 = %d, want 14", view.AnchorUserMessages)
	}
}

// 分叉会话自己再压缩一次后，锚点要被新记录覆盖，而不是沿用原会话的。
func TestForkedSessionRecompactionOverridesAnchor(t *testing.T) {
	dir := t.TempDir()
	original := filepath.Join(dir, "original.jsonl")
	if err := os.WriteFile(original, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed original session: %v", err)
	}
	writeCompactionSidecar(t, original, map[string]any{
		"trigger": "manual", "messages": 39, "summary": "s1", "anchorUserMessages": 14,
	}, -1)

	forked := filepath.Join(dir, "forked.jsonl")
	if err := os.WriteFile(forked, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed forked session: %v", err)
	}
	copySidecarDir(t, store.SessionCheckpointDir(original), store.SessionCheckpointDir(forked))

	// 分叉会话里又压了一次
	writeCompactionSidecar(t, forked, map[string]any{
		"trigger": "manual", "messages": 12, "summary": "s2", "anchorUserMessages": 3,
	}, -1)

	view, err := latestCompactionForSession(forked)
	if err != nil {
		t.Fatalf("read forked sidecar: %v", err)
	}
	if view == nil || view.AnchorUserMessages != 3 {
		t.Fatalf("分叉会话二次压缩后的锚点 = %+v, want 3", view)
	}

	// 原会话不受影响
	orig, err := latestCompactionForSession(original)
	if err != nil {
		t.Fatalf("read original sidecar: %v", err)
	}
	if orig == nil || orig.AnchorUserMessages != 14 {
		t.Fatalf("原会话锚点被分叉会话改写了: %+v", orig)
	}
}

func copySidecarDir(t *testing.T, from, to string) {
	t.Helper()
	if err := os.MkdirAll(to, 0o755); err != nil {
		t.Fatalf("mkdir target sidecar: %v", err)
	}
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatalf("read source sidecar: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(from, entry.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(to, entry.Name()), b, 0o644); err != nil {
			t.Fatalf("write %s: %v", entry.Name(), err)
		}
	}
}
