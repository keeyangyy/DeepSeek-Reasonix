package main

import (
	"reflect"
	"testing"
)

// TestParseNameStatus covers the shapes git prints: edits, additions, and
// renames, which carry two paths and only the new one is ours to look at.
func TestParseNameStatus(t *testing.T) {
	got := parseNameStatus("M\tinternal/platform/update/hub.go\nA\tnew/file.go\nR100\told.go\tnew.go\n\n")
	want := []change{
		{Status: "M", Path: "internal/platform/update/hub.go"},
		{Status: "A", Path: "new/file.go"},
		{Status: "R", Path: "new.go"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseNameStatus = %#v, want %#v", got, want)
	}
}

// testManifest is two topics that between them cover both hit kinds, with one
// guard shared by two files of the same topic.
func testManifest() manifest {
	return manifest{
		Baseline: "studio-v2.41.0",
		Topics: []forkTopic{
			{
				Topic:  "版本页双来源",
				Added:  []string{"internal/platform/update/mine_catalog.go"},
				Mounts: []string{"internal/platform/update/hub.go", "internal/platform/update/verify.go"},
				Guards: []string{"go test ./internal/platform/update/"},
			},
			{
				Topic:  "记忆写入免确认开关",
				Added:  []string{"internal/state/memory/remember_autoconfirm.go"},
				Mounts: []string{"internal/session/control/memory.go"},
				Guards: []string{"go test ./internal/state/memory/ -run Remember"},
			},
		},
	}
}

// TestMatchSortsChanges pins the report's three outputs: hits on mounted
// files, upstream's own additions, and one guard per hit topic.
func TestMatchSortsChanges(t *testing.T) {
	changes := []change{
		{Status: "M", Path: "internal/platform/update/hub.go"},
		{Status: "M", Path: "internal/platform/update/verify.go"},
		{Status: "M", Path: "internal/session/control/memory.go"},
		{Status: "M", Path: "internal/kernel/session.go"},
		{Status: "A", Path: "internal/platform/update/catalog_merge.go"},
	}
	hits, upstreamAdded, guards := match(testManifest(), changes)

	wantHits := []hit{
		{Topic: "版本页双来源", Kind: "mount", Status: "M", Path: "internal/platform/update/hub.go"},
		{Topic: "版本页双来源", Kind: "mount", Status: "M", Path: "internal/platform/update/verify.go"},
		{Topic: "记忆写入免确认开关", Kind: "mount", Status: "M", Path: "internal/session/control/memory.go"},
	}
	if !reflect.DeepEqual(hits, wantHits) {
		t.Fatalf("hits = %#v, want %#v", hits, wantHits)
	}
	if want := []string{"internal/platform/update/catalog_merge.go"}; !reflect.DeepEqual(upstreamAdded, want) {
		t.Fatalf("upstreamAdded = %#v, want %#v", upstreamAdded, want)
	}
	wantGuards := []string{"go test ./internal/platform/update/", "go test ./internal/state/memory/ -run Remember"}
	if !reflect.DeepEqual(guards, wantGuards) {
		t.Fatalf("guards = %#v, want %#v", guards, wantGuards)
	}
}

// TestMatchAddedFileIsHit covers upstream touching a file we own: a deletion
// or edit of our own addition still lands on the topic.
func TestMatchAddedFileIsHit(t *testing.T) {
	hits, _, guards := match(testManifest(), []change{
		{Status: "D", Path: "internal/platform/update/mine_catalog.go"},
	})
	want := []hit{{Topic: "版本页双来源", Kind: "added", Status: "D", Path: "internal/platform/update/mine_catalog.go"}}
	if !reflect.DeepEqual(hits, want) {
		t.Fatalf("hits = %#v, want %#v", hits, want)
	}
	if len(guards) != 1 || guards[0] != "go test ./internal/platform/update/" {
		t.Fatalf("guards = %#v, want the hit topic's guard", guards)
	}
}

// TestMatchCleanRange reports nothing for a range that misses every topic,
// which is the case the pipeline treats as "upstream's own work".
func TestMatchCleanRange(t *testing.T) {
	hits, upstreamAdded, guards := match(testManifest(), []change{
		{Status: "M", Path: "internal/kernel/session.go"},
		{Status: "A", Path: "internal/kernel/decision.go"},
	})
	if len(hits) != 0 || len(guards) != 0 {
		t.Fatalf("clean range produced hits=%#v guards=%#v", hits, guards)
	}
	if want := []string{"internal/kernel/decision.go"}; !reflect.DeepEqual(upstreamAdded, want) {
		t.Fatalf("upstreamAdded = %#v, want %#v", upstreamAdded, want)
	}
}
