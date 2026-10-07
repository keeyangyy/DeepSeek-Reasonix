package doctor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/agent"
)

func writeFingerprintSession(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name+".jsonl")
	if err := os.WriteFile(path, []byte(`{"role":"user","content":"hello"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestAnalyzeSessionFingerprintDetectsStaleMeta covers the shape that stalls
// history paging: an authoritative sidecar whose digest cannot match the
// transcript.
func TestAnalyzeSessionFingerprintDetectsStaleMeta(t *testing.T) {
	dir := t.TempDir()
	path := writeFingerprintSession(t, dir, "stale")
	if err := agent.SaveBranchMeta(path, agent.BranchMeta{
		ID: "stale", Revision: 7, ContentDigest: strings.Repeat("a", 64),
	}); err != nil {
		t.Fatal(err)
	}

	report := AnalyzeSessionFingerprint(path)
	if report.Status != FingerprintStaleMeta {
		t.Fatalf("status = %q, want %q (note: %s)", report.Status, FingerprintStaleMeta, report.Note)
	}
	if report.MetaRevision != 7 {
		t.Fatalf("meta revision = %d, want 7", report.MetaRevision)
	}
	if report.ContentDigest == "" || report.ContentDigest == report.MetaDigest {
		t.Fatalf("content %q should differ from meta %q", report.ContentDigest, report.MetaDigest)
	}
}

// TestAnalyzeSessionFingerprintSkipsLegacySidecar guards the "no authoritative
// identity" case: without revision/digest there is nothing to re-align from.
func TestAnalyzeSessionFingerprintSkipsLegacySidecar(t *testing.T) {
	dir := t.TempDir()
	path := writeFingerprintSession(t, dir, "legacy")
	if err := agent.SaveBranchMeta(path, agent.BranchMeta{ID: "legacy"}); err != nil {
		t.Fatal(err)
	}
	if report := AnalyzeSessionFingerprint(path); report.Status == FingerprintStaleMeta {
		t.Fatalf("legacy sidecar reported as stale-meta: %+v", report)
	}
}

// TestRepairStaleSessionFingerprintsDryRunWritesNothing guards the promise that
// dry-run never touches data.
func TestRepairStaleSessionFingerprintsDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	path := writeFingerprintSession(t, dir, "dry")
	if err := agent.SaveBranchMeta(path, agent.BranchMeta{
		ID: "dry", Revision: 3, ContentDigest: strings.Repeat("b", 64),
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	results := RepairStaleSessionFingerprints(context.Background(), ScanSessionFingerprints([]string{dir}), true)
	if len(results) != 1 || results[0].Status != "would-repair" {
		t.Fatalf("dry-run results = %+v, want exactly one would-repair", results)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("dry-run modified the transcript")
	}
}

// TestRepairStaleSessionFingerprintsRepairsAndIsIdempotent covers the real
// repair: the sidecar is re-aligned, a second pass is a no-op, and the
// transcript content is untouched.
func TestRepairStaleSessionFingerprintsRepairsAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := writeFingerprintSession(t, dir, "repair")
	if err := agent.SaveBranchMeta(path, agent.BranchMeta{
		ID: "repair", Revision: 5, ContentDigest: strings.Repeat("c", 64),
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	first := RepairStaleSessionFingerprints(context.Background(), ScanSessionFingerprints([]string{dir}), false)
	if len(first) != 1 || first[0].Status == "error" {
		t.Fatalf("repair results = %+v, want one successful repair", first)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("repair modified the transcript content")
	}

	report := AnalyzeSessionFingerprint(path)
	if report.Status == FingerprintStaleMeta {
		t.Fatalf("sidecar still stale after repair: %+v", report)
	}
	if second := RepairStaleSessionFingerprints(context.Background(), ScanSessionFingerprints([]string{dir}), false); len(second) != 0 {
		t.Fatalf("second repair pass offered %d candidates, want 0 (idempotent)", len(second))
	}
}
