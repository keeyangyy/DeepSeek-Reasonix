package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"reasonix/internal/store"
)

// writeCompactionSidecar lays out a session sidecar for one case: a record
// (nil to omit) and a running marker aged by markerAge (negative to omit).
func writeCompactionSidecar(t *testing.T, sessionPath string, record map[string]any, markerAge time.Duration) string {
	t.Helper()
	dir := store.SessionCheckpointDir(sessionPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir sidecar: %v", err)
	}
	if record != nil {
		b, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal record: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "latest-compaction.json"), b, 0o644); err != nil {
			t.Fatalf("write record: %v", err)
		}
	}
	if markerAge >= 0 {
		b, err := json.Marshal(map[string]string{
			"startedAt": strconv.FormatInt(time.Now().Add(-markerAge).UnixMilli(), 10),
		})
		if err != nil {
			t.Fatalf("marshal marker: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "compacting.json"), b, 0o644); err != nil {
			t.Fatalf("write marker: %v", err)
		}
	}
	return dir
}

// A fold in flight must outrank the previous run's record: otherwise switching
// away mid-compact and coming back shows a finished card while the summary is
// still being written, and the "compacting" state looks like it vanished.
func TestLatestCompactionPrefersRunningMarkerOverPreviousRecord(t *testing.T) {
	sessionPath := filepath.Join(t.TempDir(), "session.jsonl")
	writeCompactionSidecar(t, sessionPath, map[string]any{
		"trigger": "manual", "messages": 12, "summary": "上一次的摘要", "anchorUserMessages": 7,
	}, 0)

	got, err := latestCompactionForSession(sessionPath)
	if err != nil {
		t.Fatalf("latestCompactionForSession: %v", err)
	}
	if got == nil || !got.InProgress {
		t.Fatalf("got %+v, want InProgress while a fold is running", got)
	}
	if got.Summary != "" {
		t.Fatalf("running state must not carry the previous summary, got %q", got.Summary)
	}
}

// A marker left behind by a killed process is not a live fold: it is cleared and
// the recorded result is served, so the session cannot stay stuck on
// "compacting" forever.
func TestLatestCompactionClearsStaleMarkerAndFallsBackToRecord(t *testing.T) {
	sessionPath := filepath.Join(t.TempDir(), "session.jsonl")
	dir := writeCompactionSidecar(t, sessionPath, map[string]any{
		"trigger": "manual", "messages": 9, "summary": "上一次的摘要", "anchorUserMessages": 5,
	}, compactionMarkerStaleAfter+time.Minute)

	got, err := latestCompactionForSession(sessionPath)
	if err != nil {
		t.Fatalf("latestCompactionForSession: %v", err)
	}
	if got == nil || got.InProgress || got.Summary != "上一次的摘要" {
		t.Fatalf("got %+v, want the recorded summary once the marker is stale", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "compacting.json")); !os.IsNotExist(err) {
		t.Fatalf("stale marker should be removed, stat err = %v", err)
	}
}

func TestLatestCompactionReturnsRecordWithoutMarker(t *testing.T) {
	sessionPath := filepath.Join(t.TempDir(), "session.jsonl")
	writeCompactionSidecar(t, sessionPath, map[string]any{
		"trigger": "auto", "messages": 4, "summary": "摘要", "anchorUserMessages": 3,
		"afterMessageId": "01ABC",
	}, -1)

	got, err := latestCompactionForSession(sessionPath)
	if err != nil {
		t.Fatalf("latestCompactionForSession: %v", err)
	}
	if got == nil || got.InProgress {
		t.Fatalf("got %+v, want the finished record", got)
	}
	if got.Messages != 4 || got.AnchorUserMessages != 3 || got.AfterMessageID != "01ABC" {
		t.Fatalf("record fields not carried through: %+v", got)
	}
}

func TestLatestCompactionNilWhenNothingRecorded(t *testing.T) {
	sessionPath := filepath.Join(t.TempDir(), "session.jsonl")
	writeCompactionSidecar(t, sessionPath, nil, -1)

	got, err := latestCompactionForSession(sessionPath)
	if err != nil {
		t.Fatalf("latestCompactionForSession: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil for a session that never compacted", got)
	}
}
