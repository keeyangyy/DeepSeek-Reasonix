package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// A session owns its reasoning effort: the sidecar round-trips the level, an
// empty write records "auto", and effort writes leave the model untouched.
func TestSessionEffortSidecarRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatalf("seed session file: %v", err)
	}

	if effort, ok := LoadSessionEffort(path); ok {
		t.Fatalf("effort = %q reported for a session without a sidecar", effort)
	}
	if err := SetBranchEffortPreserveUpdated(path, "max"); err != nil {
		t.Fatalf("SetBranchEffortPreserveUpdated: %v", err)
	}
	got, ok := LoadSessionEffort(path)
	if !ok || got != "max" {
		t.Fatalf("effort = %q/%v, want max/true", got, ok)
	}
	// An effort-only write must not disturb the model recorded beside it.
	if err := SetBranchModelPreserveUpdated(path, "prov/model"); err != nil {
		t.Fatalf("SetBranchModelPreserveUpdated: %v", err)
	}
	if err := SetBranchEffortPreserveUpdated(path, "high"); err != nil {
		t.Fatalf("SetBranchEffortPreserveUpdated(high): %v", err)
	}
	if model, ok := LoadSessionModel(path); !ok || model != "prov/model" {
		t.Fatalf("model = %q/%v, want prov/model/true", model, ok)
	}
	if got, ok := LoadSessionEffort(path); !ok || got != "high" {
		t.Fatalf("effort = %q/%v, want high/true", got, ok)
	}
	// auto clears the level without dropping the sidecar.
	if err := SetBranchEffortPreserveUpdated(path, ""); err != nil {
		t.Fatalf("SetBranchEffortPreserveUpdated(auto): %v", err)
	}
	if got, ok := LoadSessionEffort(path); !ok || got != "" {
		t.Fatalf("effort after auto = %q/%v, want empty/true", got, ok)
	}
	if _, err := os.Stat(BranchMetaPath(path)); err != nil {
		t.Fatalf("sidecar missing after effort writes: %v", err)
	}
}