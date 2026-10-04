package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// The filter decides by stamp first, then by trace: a session this line created
// carries the stamp; a session written here before the stamp existed carries a
// native field; a session with neither was never touched here.
func TestIsForeignSessionPrefersStampThenTrace(t *testing.T) {
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
	stamped := withMeta("stamped", `{"id":"s","created_by":"reasonix-1x","topic_title":"t"}`)
	otherLine := withMeta("other", `{"id":"o","created_by":"reasonix-2x"}`)
	legacyOurs := withMeta("legacy", `{"id":"l","head_id":"main","log_schema":2}`)
	untouched := withMeta("untouched", `{"id":"u","topic_title":"t","preview":"hello"}`)
	archived := withMeta("archived", `{"id":"a","archived":true}`)
	noSidecar := filepath.Join(dir, "bare.jsonl")
	if err := os.WriteFile(noSidecar, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if IsForeignSession(stamped) {
		t.Fatal("a session stamped by this line was claimed as the other line's")
	}
	if !IsForeignSession(otherLine) {
		t.Fatal("another line's stamp was not detected")
	}
	if IsForeignSession(legacyOurs) {
		t.Fatal("an older session of ours (native field, no stamp) was claimed")
	}
	if !IsForeignSession(untouched) {
		t.Fatal("a sidecar with no trace of this line was not claimed")
	}
	if !IsForeignSession(archived) {
		t.Fatal("the other line's archived sidecar was not detected")
	}
	if IsForeignSession(noSidecar) {
		t.Fatal("a session without a sidecar must not be claimed")
	}
}

// The stamp is what makes the filter self-sufficient going forward: a session
// saved by this build is never mistaken for the other line's, and a session
// that already carries an identity keeps it.
func TestSaveBranchMetaStampsThisLineOnce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveBranchMetaPreserveUpdated(path, BranchMeta{ID: "s", Scope: "global"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	meta, ok, err := LoadBranchMeta(path)
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if meta.CreatedBy != SessionCreatedByLine {
		t.Fatalf("created_by = %q, want %q", meta.CreatedBy, SessionCreatedByLine)
	}
	if IsForeignSession(path) {
		t.Fatal("a session this build just saved was claimed as the other line's")
	}
	if err := SaveBranchMetaPreserveUpdated(path, BranchMeta{ID: "s", Scope: "global", CreatedBy: "other-line"}); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	again, _, err := LoadBranchMeta(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.CreatedBy != "other-line" {
		t.Fatalf("existing stamp was overwritten: %q", again.CreatedBy)
	}
}
