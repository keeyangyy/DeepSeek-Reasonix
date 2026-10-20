package workspacelease

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// unrelatedTreePath finds a workspace root whose hierarchy lock slot does not
// collide with the blocker's, after canonical path normalization. Random temp
// paths can otherwise land on the same bounded stripe (macOS /var symlinks,
// Windows case folding), making a parallelism test serialize by accident.
func unrelatedTreePath(t *testing.T, blocker *Owner, base string) (string, string) {
	t.Helper()
	blockedSlot := blocker.treeLockPath(blocker.canonical)
	for i := 1; i < treeLockStripes*2; i++ {
		root := filepath.Join(base, fmt.Sprintf("workspace-%d", i))
		path := filepath.Join(root, "b.go")
		rootKey, _, err := canonicalFileKey(root)
		if err != nil {
			t.Fatal(err)
		}
		pathKey, _, err := canonicalFileKey(path)
		if err != nil {
			t.Fatal(err)
		}
		if blocker.treeLockPath(rootKey) == blockedSlot || blocker.treeLockPath(pathKey) == blockedSlot {
			continue
		}
		if err := os.Mkdir(root, 0o700); err != nil {
			t.Fatal(err)
		}
		return root, path
	}
	t.Fatal("could not find unrelated hierarchy lock slots")
	return "", ""
}

// distinctPathSlotInDirectory picks a path in dir whose lock stripe differs
// from blockedSlot, so two parallel writes really do run concurrently.
func distinctPathSlotInDirectory(t *testing.T, owner *Owner, dir, blockedSlot string) string {
	t.Helper()
	for i := range pathLockStripes * 2 {
		path := filepath.Join(dir, fmt.Sprintf("parallel-%d.go", i))
		if canonicalPathSlot(t, owner, path) != blockedSlot {
			return path
		}
	}
	t.Fatal("could not find a distinct path stripe in the requested directory")
	return ""
}
