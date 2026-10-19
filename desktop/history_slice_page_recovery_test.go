package main

import (
	"os"
	"path/filepath"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/store"
)

// The recovery hook rebuilds a repairable session's read model so the caller's
// retry can succeed. Verified directly: a page-failure code path is hard to
// reach on purpose, but the hook's contract is what the retry depends on.
func TestRebuildHistoryReadModelOnPageFailureRepairsRepairableSession(t *testing.T) {
	_ = historySliceTestApp(t)
	root := t.TempDir()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	const src = `C:/Users/53435/AppData/Roaming/reasonix/projects/d--project-prj-github/sessions/20261018-163839.879359400-axon-deepseek-flash`
	const name = "recoverable"
	var sessionPath string
	for _, suffix := range []string{".jsonl", ".events.jsonl", ".jsonl.meta"} {
		data, err := os.ReadFile(src + suffix)
		if err != nil {
			t.Skipf("reference session missing %s: %v", suffix, err)
		}
		dst := filepath.Join(dir, name+suffix)
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if suffix == ".jsonl" {
			sessionPath = dst
		}
	}
	if info, err := os.Stat(store.SessionEventLog(sessionPath)); err != nil || info.Size() == 0 {
		t.Skip("fixture has no authoritative event log")
	}
	// No display index: the read model has to be built by the hook.
	indexPath := store.SessionDisplayIndex(sessionPath)
	if _, err := os.Stat(indexPath); err == nil {
		t.Fatalf("fixture unexpectedly shipped an index")
	}

	if !rebuildHistoryReadModelOnPageFailure(sessionPath, "test-cause") {
		t.Fatalf("hook declined to recover a repairable session")
	}

	idx, err := agent.LoadSessionDisplayIndex(indexPath)
	if err != nil || idx == nil {
		t.Fatalf("hook did not publish an index: %v", err)
	}
	msgs, state, repairable, err := agent.LoadSessionDisplayMessages(sessionPath)
	if err != nil || !repairable {
		t.Fatalf("transcript unreadable after hook: %v", err)
	}
	if idx.MessageCount != len(msgs) {
		t.Fatalf("index covers %d, transcript has %d", idx.MessageCount, len(msgs))
	}
	if state.DigestHex != "" && idx.ContentDigest != state.DigestHex {
		t.Fatalf("index digest %s != transcript %s", idx.ContentDigest, state.DigestHex)
	}
}

// A session this build cannot replay belongs to another line: the hook must
// refuse it and leave every file byte-identical.
func TestRebuildHistoryReadModelOnPageFailureRefusesForeignSchema(t *testing.T) {
	_ = historySliceTestApp(t)
	root := t.TempDir()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	path := filepath.Join(dir, "foreign.jsonl")
	body := []byte(`{"schema_version":99,"type":"message","id":"x1"}` + "\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	if err := os.WriteFile(store.SessionEventLog(path), body, 0o644); err != nil {
		t.Fatalf("write event log: %v", err)
	}
	metaJSON := `{"id":"foreign","revision":7,"content_digest":"1111111111111111111111111111111111111111111111111111111111111111"}`
	if err := os.WriteFile(path+".meta", []byte(metaJSON), 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}

	before := map[string][]byte{}
	for _, p := range []string{path, path + ".meta", store.SessionEventLog(path)} {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		before[p] = data
	}

	if rebuildHistoryReadModelOnPageFailure(path, "test-cause") {
		t.Fatalf("hook claimed to recover a foreign-schema session")
	}

	for p, want := range before {
		got, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("re-read %s: %v", p, err)
		}
		if string(got) != string(want) {
			t.Fatalf("hook rewrote %s", p)
		}
	}
	if _, err := os.Stat(store.SessionDisplayIndex(path)); err == nil {
		t.Fatalf("hook published an index for a foreign session")
	}
}
