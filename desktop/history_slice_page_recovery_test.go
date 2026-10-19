package main

import (
	"encoding/hex"
	"os"
	"strings"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/provider"
	"reasonix/internal/store"
)

// brokenSidecarSession reproduces the production failure the recovery hook
// exists for:
//
//	meta  revision>=1  digest=<stale digest from an earlier save>
//	index revision=0   known=false   (rows otherwise exact)
//
// It is built by saving a normal session and then corrupting only the sidecar
// digest. With meta and transcript digests disagreeing, every index build keeps
// recording revision=0 / revision_known=false, so the index can never validate —
// rebuilding the read model alone does not help.
//
// Built programmatically on purpose: an earlier version read the fixture from an
// absolute path under tmp/, which silently skipped the test everywhere else.
func brokenSidecarSession(t *testing.T) (sessionPath string) {
	t.Helper()
	_ = historySliceTestApp(t)
	root := t.TempDir()
	dir := desktopSessionDir(root)

	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: "first question"},
		{Role: provider.RoleAssistant, Content: "first answer"},
		{Role: provider.RoleUser, Content: "second question"},
		{Role: provider.RoleAssistant, Content: "second answer"},
	}
	_, sessionPath = saveHistorySliceSession(t, dir, "broken-sidecar.jsonl", msgs)

	// Confirm the healthy state first: the index must be valid as saved.
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		t.Fatalf("load meta: ok=%v err=%v", ok, err)
	}
	before, err := agent.LoadSessionDisplayIndex(store.SessionDisplayIndex(sessionPath))
	if err != nil || before == nil {
		t.Fatalf("load index: %v", err)
	}
	if !before.RevisionKnown {
		t.Fatalf("fixture did not start healthy: index revision_known already false")
	}

	// Corrupt ONLY the sidecar digest, leaving the transcript untouched. This is
	// the shape seen in production: rows and byte counts are correct, the
	// identity is not.
	stale := strings.Repeat("ab", 32)
	meta.ContentDigest = stale
	meta.ListingContentDigest = stale
	if err := agent.SaveBranchMeta(sessionPath, meta); err != nil {
		t.Fatalf("rewrite meta: %v", err)
	}

	// Republishing the index from this state is exactly what the old repair did:
	// it must come out with an unusable identity.
	if err := agent.RepairSessionDisplayReadModel(sessionPath); err != nil {
		t.Fatalf("publish index from stale sidecar: %v", err)
	}
	broken, err := agent.LoadSessionDisplayIndex(store.SessionDisplayIndex(sessionPath))
	if err != nil || broken == nil {
		t.Fatalf("reload index: %v", err)
	}
	if broken.RevisionKnown {
		t.Skip("this build does not lose the index identity from a stale sidecar digest; the regression no longer reproduces")
	}
	t.Logf("reproduced: meta.rev=%d meta.dig=%s idx.rev=%d idx.known=%v",
		meta.Revision, shortDigest(meta.ContentDigest), broken.Revision, broken.RevisionKnown)
	return sessionPath
}

// After the recovery hook runs, the index must be usable again: its revision
// must be known and must agree with the sidecar.
func TestRebuildHistoryReadModelOnPageFailureRepairsStaleSidecarIdentity(t *testing.T) {
	sessionPath := brokenSidecarSession(t)

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
	msgs, state, repairable, err := agent.LoadSessionDisplayMessages(sessionPath)
	if err != nil || !repairable {
		t.Fatalf("transcript unreadable after recovery: repairable=%v err=%v", repairable, err)
	}
	t.Logf("after recovery: meta.rev=%d idx.rev=%d idx.known=%v", meta.Revision, idx.Revision, idx.RevisionKnown)

	// The sidecar must agree with the transcript again.
	if !strings.EqualFold(strings.TrimSpace(meta.ContentDigest), strings.TrimSpace(state.DigestHex)) {
		t.Fatalf("sidecar digest not re-aligned: meta=%s transcript=%s", meta.ContentDigest, state.DigestHex)
	}
	// The decisive check: a usable identity. Before the fix this was always false.
	if !idx.RevisionKnown {
		t.Fatalf("index revision_known=false after recovery; the page would still fail")
	}
	if idx.Revision != meta.Revision {
		t.Fatalf("index revision %d != sidecar revision %d", idx.Revision, meta.Revision)
	}
	if idx.MessageCount != len(msgs) {
		t.Fatalf("index covers %d messages, transcript has %d", idx.MessageCount, len(msgs))
	}
	digest, err := decodeDigest(meta.ContentDigest)
	if err != nil {
		t.Fatalf("decode digest: %v", err)
	}
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

	path := dir + string(os.PathSeparator) + "foreign.jsonl"
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

func shortDigest(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 16 {
		return s[:16]
	}
	return s
}

func decodeDigest(hexDigest string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(strings.TrimSpace(hexDigest))
	if err != nil || len(raw) != 32 {
		return out, err
	}
	copy(out[:], raw)
	return out, nil
}
