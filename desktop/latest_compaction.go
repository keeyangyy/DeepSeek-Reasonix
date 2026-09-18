package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"reasonix/internal/agent"
	"reasonix/internal/store"
)

// LatestCompactionView is the persisted compaction record for one session.
// InProgress is true when a compaction is still running (marker present).
type LatestCompactionView struct {
	InProgress bool   `json:"inProgress,omitempty"`
	Trigger    string `json:"trigger,omitempty"`
	Messages   int    `json:"messages"`
	Summary    string `json:"summary"`
}

// LatestCompactionForTab returns the most recent compaction record persisted
// in the session sidecar (<session>.ckpt/latest-compaction.json). A tab that
// was switched away mid-compaction can still render the compression result on
// re-open: the done event stream is gone with the released tab, but the
// sidecar survives on disk. When the compaction is still running (marker
// present) it returns InProgress so the frontend can poll until completion.
// Nil when the session has no recorded compaction at all.
func (a *App) LatestCompactionForTab(tabID string) (*LatestCompactionView, error) {
	_, ctrl := a.tabAndCtrlByID(tabID)
	if ctrl == nil {
		return nil, nil
	}
	path := ctrl.SessionPath()
	if path == "" {
		return nil, nil
	}
	ckptDir := store.SessionCheckpointDir(path)
	b, err := os.ReadFile(filepath.Join(ckptDir, "latest-compaction.json"))
	if err == nil {
		var rec agent.CompactionRecord
		if err := json.Unmarshal(b, &rec); err == nil {
			return &LatestCompactionView{Trigger: rec.Trigger, Messages: rec.Messages, Summary: rec.Summary}, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(ckptDir, "compacting.json")); err == nil {
		return &LatestCompactionView{InProgress: true}, nil
	}
	return nil, nil
}
