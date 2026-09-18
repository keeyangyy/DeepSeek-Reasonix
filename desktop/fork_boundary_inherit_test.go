package main

import (
	"path/filepath"
	"testing"

	"reasonix/internal/checkpoint"
	"reasonix/internal/store"
)

// TestInheritForkCheckpointBoundaries verifies the fork boundary inheritance:
// a fork's fresh session dir receives the conversation boundaries up to the
// fork point (so turn actions stay enabled) but never any file payload (the
// fork's workspace differs).
func TestInheritForkCheckpointBoundaries(t *testing.T) {
	dir := t.TempDir()
	srcSession := filepath.Join(dir, "root.jsonl")
	dstSession := filepath.Join(dir, "fork-1.jsonl")

	// Source session with persisted checkpoints for turn 1 and turn 2
	// (Begin persists each checkpoint to <session>.ckpt/turn-N.json).
	src := checkpoint.New(store.SessionCheckpointDir(srcSession), "")
	src.Begin(1, "first prompt", 2)
	src.Begin(2, "second prompt", 4)
	if len(src.Bounds()) == 0 {
		t.Fatal("precondition: no source boundaries")
	}

	// Fork at turn 1: only boundaries <= turn 1 must be inherited.
	if err := inheritForkCheckpointBoundaries(srcSession, dstSession, 1); err != nil {
		t.Fatalf("inheritForkCheckpointBoundaries: %v", err)
	}
	dst := checkpoint.New(store.SessionCheckpointDir(dstSession), "")
	bounds := dst.Bounds()
	if _, ok := bounds[1]; !ok {
		t.Fatalf("fork must inherit turn 1 boundary, got %v", bounds)
	}
	if _, ok := bounds[2]; ok {
		t.Fatalf("fork must not inherit turn 2 (past the fork point), got %v", bounds)
	}
	for _, meta := range dst.List() {
		if len(meta.Paths) > 0 || meta.CanUndoFiles {
			t.Fatalf("fork boundary must never inherit file payload: %+v", meta)
		}
	}
}