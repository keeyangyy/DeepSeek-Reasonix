package fileops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRequireObservedAllowsUnreadFile pins the deliberate allowance: the host
// cannot tell "never read" from "written blind on purpose", so an unread target
// is not blocked. Only a stale version is refused.
func TestRequireObservedAllowsUnreadFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := WithStore(context.Background(), NewStore())

	if err := RequireObserved(ctx, path); err != nil {
		t.Fatalf("RequireObserved on unread file = %v, want nil", err)
	}
}

// TestRequireObservedAllowsAfterRead is the happy path: reading records the
// version, and the write is then permitted.
func TestRequireObservedAllowsAfterRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := WithStore(context.Background(), NewStore())

	ObserveRead(ctx, path)
	if err := RequireObserved(ctx, path); err != nil {
		t.Fatalf("RequireObserved after read = %v, want nil", err)
	}
}

// TestRequireObservedRefusesStaleVersion pins the second refusal: a file edited
// outside the session after it was read must not be silently replaced.
func TestRequireObservedRefusesStaleVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := WithStore(context.Background(), NewStore())
	ObserveRead(ctx, path)

	// Land a different size so the metadata version changes even on filesystems
	// with coarse timestamps.
	if err := os.WriteFile(path, []byte("changed by someone else"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)

	err := RequireObserved(ctx, path)
	if !errors.Is(err, ErrStaleVersion) {
		t.Fatalf("RequireObserved after outside edit = %v, want ErrStaleVersion", err)
	}
}

// TestCommitObservedRefreshesVersion keeps consecutive edits working without a
// second read.
func TestCommitObservedRefreshesVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := WithStore(context.Background(), NewStore())
	ObserveRead(ctx, path)

	if err := os.WriteFile(path, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	CommitObserved(ctx, path)

	if err := RequireObserved(ctx, path); err != nil {
		t.Fatalf("RequireObserved after commit = %v, want nil", err)
	}
}

// TestRequireObservedNilStorePermits keeps direct package-level tool calls
// usable in tests and embeddings, matching the upstream contract.
func TestRequireObservedNilStorePermits(t *testing.T) {
	if err := RequireObserved(context.Background(), filepath.Join(t.TempDir(), "absent.txt")); err != nil {
		t.Fatalf("RequireObserved without store = %v, want nil", err)
	}
}

// TestRequireObservedAllowsMissingTarget keeps file creation working: a target
// that does not exist has no version to compare.
func TestRequireObservedAllowsMissingTarget(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.txt")
	ctx := WithStore(context.Background(), NewStore())

	if err := RequireObserved(ctx, path); err != nil {
		t.Fatalf("RequireObserved on missing target = %v, want nil", err)
	}
}

// TestObserveReadIgnoresMissingFile keeps a failed read from recording a
// present version that was never delivered.
func TestObserveReadIgnoresMissingFile(t *testing.T) {
	store := NewStore()
	ctx := WithStore(context.Background(), store)
	ObserveRead(ctx, filepath.Join(t.TempDir(), "missing.txt"))

	if got := store.Get(DiskTarget(filepath.Join(t.TempDir(), "missing.txt"), nil)); got.Kind == Present {
		t.Fatalf("ObserveRead recorded Present for a missing file")
	}
}
