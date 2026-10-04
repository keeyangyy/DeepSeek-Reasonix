package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// The filter must be conservative: hiding one of this build's own sessions
// loses work, while showing one of the other line's is merely noise.
func TestIsForeignSessionOnlyClaimsTheOtherLinesKeys(t *testing.T) {
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
	ours := withMeta("ours", `{"id":"ours","schema_version":2,"head_id":"main","log_schema":2,"custom_title":"named"}`)
	archived := withMeta("archived", `{"id":"a","scope":"project","topic_title":"t","archived":true}`)
	superseded := withMeta("superseded", `{"id":"s","superseded":true}`)
	plain := withMeta("plain", `{"id":"p","topic_title":"t","preview":"hello"}`)

	if IsForeignSession(ours) {
		t.Fatal("this build's own sidecar was classified as the other line's")
	}
	if !IsForeignSession(archived) {
		t.Fatal("the other line's archived sidecar was not detected")
	}
	if !IsForeignSession(superseded) {
		t.Fatal("the other line's superseded sidecar was not detected")
	}
	if IsForeignSession(plain) {
		t.Fatal("a sidecar with none of those keys must not be claimed")
	}
}
