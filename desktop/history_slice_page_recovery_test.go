package main

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/store"
)

// brokenSidecarFixture reproduces the captured production failure:
//
//	meta  revision=990  digest=<transcript digest at last save>
//	index revision=0    known=false    (content otherwise exact)
//
// The sidecar digest no longer matches the replayed transcript, so every index
// build records revision=0 / revision_known=false and the index can never
// validate — rebuilding it repeatedly does not help. The rows themselves are
// fine; only the identity is unusable.
//
// The capture lives under the repo tmp dir so the case is reproducible without
// depending on the user's live session directory.
func brokenSidecarFixture(t *testing.T) (sessionPath string) {
	t.Helper()
	_ = historySliceTestApp(t)
	root := t.TempDir()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	const captured = `D:/project/prj-github/tmp/DeepSeek-Reasonix/broken-session-20261019`
	const base = "20261018-163839.879359400-axon-deepseek-flash"
	for _, suffix := range []string{".jsonl", ".events.jsonl", ".display-index.json", ".jsonl.meta", ".turns.jsonl"} {
		data, err := os.ReadFile(filepath.Join(filepath.FromSlash(captured), base+suffix))
		if err != nil {
			t.Skipf("captured session missing %s: %v", suffix, err)
		}
		dst := filepath.Join(dir, base+suffix)
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			t.Fatalf("write %s: %v", suffix, err)
		}
		if suffix == ".jsonl" {
			sessionPath = dst
		}
	}
	return sessionPath
}

// The captured failure must become usable after the recovery hook runs.
//
// The essential assertion is the index IDENTITY, not merely that a rebuild
// happened: an earlier attempt rebuilt the read model but the index still came
// out with revision=0, so the page kept failing. Only re-aligning the sidecar
// digest from the transcript makes the revision recoverable.
func TestRebuildHistoryReadModelOnPageFailureRepairsStaleSidecarIdentity(t *testing.T) {
	sessionPath := brokenSidecarFixture(t)

	before, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		t.Fatalf("load meta: ok=%v err=%v", ok, err)
	}
	beforeIdx, err := agent.LoadSessionDisplayIndex(store.SessionDisplayIndex(sessionPath))
	if err != nil || beforeIdx == nil {
		t.Fatalf("load index: %v", err)
	}
	t.Logf("before: meta.rev=%d idx.rev=%d idx.known=%v", before.Revision, beforeIdx.Revision, beforeIdx.RevisionKnown)

	if !rebuildHistoryReadModelOnPageFailure(sessionPath, "test-cause") {
		t.Fatalf("recovery hook declined a repairable session")
	}

	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		t.Fatalf("reload meta: ok=%v err=%v", ok, err)
	}
	idx, err := agent.LoadSessionDisplayIndex(store.SessionDisplayIndex(sessionPath))
	if err != nil || idx == nil {
		t.Fatalf("reload index: %v", err)
	}
	t.Logf("after : meta.rev=%d idx.rev=%d idx.known=%v", meta.Revision, idx.Revision, idx.RevisionKnown)

	// The sidecar must now agree with the transcript, which is what makes the
	// revision meaningful again.
	msgs, state, repairable, err := agent.LoadSessionDisplayMessages(sessionPath)
	if err != nil || !repairable {
		t.Fatalf("transcript unreadable after recovery: repairable=%v err=%v", repairable, err)
	}
	if !strings.EqualFold(strings.TrimSpace(meta.ContentDigest), strings.TrimSpace(state.DigestHex)) {
		t.Fatalf("sidecar digest not re-aligned: meta=%s transcript=%s", meta.ContentDigest, state.DigestHex)
	}

	// The decisive check: the index must validate against the sidecar identity.
	// Before the fix this was always false because the index carried revision=0.
	if idx.RevisionKnown != true {
		t.Fatalf("index revision_known = false after recovery; the page would still fail")
	}
	if idx.Revision != meta.Revision {
		t.Fatalf("index revision %d != sidecar revision %d", idx.Revision, meta.Revision)
	}
	if idx.MessageCount != len(msgs) {
		t.Fatalf("index covers %d messages, transcript has %d", idx.MessageCount, len(msgs))
	}
	digest := parseHexDigest(t, meta.ContentDigest)
	info, err := os.Stat(sessionPath)
	if err != nil {
		t.Fatalf("stat transcript: %v", err)
	}
	if !agent.ValidateSessionDisplayIndex(idx, meta.Revision, true, digest, info.Size()) {
		t.Fatalf("index still does not validate after recovery")
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

func parseHexDigest(t *testing.T, hexDigest string) [32]byte {
	t.Helper()
	var out [32]byte
	raw, err := hex.DecodeString(strings.TrimSpace(hexDigest))
	if err != nil || len(raw) != 32 {
		t.Fatalf("bad digest %q: %v", hexDigest, err)
	}
	copy(out[:], raw)
	return out
}
