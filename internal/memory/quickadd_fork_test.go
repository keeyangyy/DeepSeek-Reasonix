package memory

import (
	"strings"
	"testing"
)

// TestAppendDocPropagatesReadErrors pins the fail-safe contract: a doc-memory
// file that exists but cannot be read (permission, encoding, IO) must surface
// the read error instead of treating the file as empty and overwriting it with
// a fresh Notes-only document, which would silently destroy existing content.
func TestAppendDocPropagatesReadErrors(t *testing.T) {
	// A directory is a real path that os.ReadFile refuses with a non-NotExist
	// error (EISDIR), exercising the "exists but unreadable" branch without
	// relying on permission bits that vary across platforms and CI users.
	dir := t.TempDir()
	if err := AppendDoc(dir, "note"); err == nil {
		t.Fatal("AppendDoc on an unreadable path must fail")
	} else if !strings.Contains(err.Error(), "read") {
		t.Fatalf("error must surface the read failure, got %q", err)
	}
}
