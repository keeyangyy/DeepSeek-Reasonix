package main

import (
	"context"
	"os"
	"testing"
)

// TestSyncSessionCatalogMetadataIdempotent proves the 30s refresh loop does not
// re-publish the project tree when the derived projects/topics metadata is
// unchanged: Catalog.SyncMetadata always rewrites rows and bumps the revision,
// which re-renders the sidebar every 30 seconds. The desktop guard must skip
// the catalog write for identical metadata and still refresh on real changes.
func TestSyncSessionCatalogMetadataIdempotent(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := t.TempDir()
	if err := addProject(root, "Idempotent project"); err != nil {
		t.Fatal(err)
	}
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTopicSession(t, dir, "a.jsonl", "a", "A", root)
	if err := setTopicTitle(root, "a", "A"); err != nil {
		t.Fatal(err)
	}
	if err := updateProjectsFile(func(f *desktopProjectFile) (bool, error) {
		f.Projects[projectIndexByRoot(f.Projects, root)].Topics = []string{"a"}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	installSessionCatalogForTest(t, app, dir, "project", root)
	catalog := app.sessionCatalog.Load()
	ctx := context.Background()

	if err := app.syncSessionCatalogMetadata(ctx, catalog); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	revAfterFirst := catalog.Status().Revision

	// An identical second sync must be a no-op: no revision bump, no republish.
	if err := app.syncSessionCatalogMetadata(ctx, catalog); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if rev := catalog.Status().Revision; rev != revAfterFirst {
		t.Fatalf("identical sync bumped revision %d -> %d, want no-op (idempotence guard)", revAfterFirst, rev)
	}

	// A real change (new topic) must still refresh the catalog.
	writeTopicSession(t, dir, "b.jsonl", "b", "B", root)
	if err := setTopicTitle(root, "b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := updateProjectsFile(func(f *desktopProjectFile) (bool, error) {
		f.Projects[projectIndexByRoot(f.Projects, root)].Topics = []string{"a", "b"}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := app.syncSessionCatalogMetadata(ctx, catalog); err != nil {
		t.Fatalf("changed sync: %v", err)
	}
	if rev := catalog.Status().Revision; rev <= revAfterFirst {
		t.Fatalf("changed metadata must bump revision, got %d after %d", rev, revAfterFirst)
	}
}
