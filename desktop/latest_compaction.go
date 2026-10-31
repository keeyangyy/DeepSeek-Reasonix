package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/store"
)

// compactionMarkerStaleAfter bounds how long a persisted "compacting" marker is
// trusted. The marker is written before a fold starts and removed when it
// finishes; a process killed mid-fold leaves one behind, and without a bound the
// session would read "compacting" forever.
const compactionMarkerStaleAfter = 10 * time.Minute

// LatestCompactionView is the persisted compaction record for one session.
// InProgress is true when a compaction is still running (marker present).
type LatestCompactionView struct {
	InProgress bool   `json:"inProgress,omitempty"`
	Trigger    string `json:"trigger,omitempty"`
	Messages   int    `json:"messages"`
	Summary    string `json:"summary"`
	// AnchorUserMessages 是压缩发生在第几轮之后（压缩覆盖的真实用户消息数）。
	// 前端据此把卡片插回轮次边界；缺失（0）表示旧记录没有位置，前端不渲染。
	AnchorUserMessages int `json:"anchorUserMessages,omitempty"`
	// AfterMessageID 是压缩分界处最后一条消息的 ULID，前端据此精确定位卡片。
	AfterMessageID string `json:"afterMessageId,omitempty"`
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
	return latestCompactionForSession(path)
}

// latestCompactionForSession reads one session's compaction sidecar. Split from
// the tab lookup so the ordering rules (running marker first, then the record)
// are testable without an App.
func latestCompactionForSession(sessionPath string) (*LatestCompactionView, error) {
	ckptDir := store.SessionCheckpointDir(sessionPath)
	// A run in flight outranks the record it is about to replace: the sidecar
	// keeps the previous run's record until this one commits, so reading the
	// record first would show a finished card while a fold is still running.
	if compactionRunning(ckptDir) {
		return &LatestCompactionView{InProgress: true}, nil
	}
	b, err := os.ReadFile(filepath.Join(ckptDir, "latest-compaction.json"))
	if err == nil {
		var rec agent.CompactionRecord
		if err := json.Unmarshal(b, &rec); err == nil {
			return &LatestCompactionView{Trigger: rec.Trigger, Messages: rec.Messages, Summary: rec.Summary,
				AnchorUserMessages: rec.AnchorUserMessages,
				AfterMessageID:     rec.AfterMessageID}, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return nil, nil
}

// compactionRunning reports whether a fold is in flight, treating a marker older
// than compactionMarkerStaleAfter as a crash leftover and clearing it so the
// session does not stay stuck on "compacting".
func compactionRunning(ckptDir string) bool {
	markerPath := filepath.Join(ckptDir, "compacting.json")
	fi, err := os.Stat(markerPath)
	if err != nil {
		return false
	}
	started := fi.ModTime()
	if b, err := os.ReadFile(markerPath); err == nil {
		var marker struct {
			StartedAt string `json:"startedAt"`
		}
		if json.Unmarshal(b, &marker) == nil {
			if ms, err := strconv.ParseInt(marker.StartedAt, 10, 64); err == nil && ms > 0 {
				started = time.UnixMilli(ms)
			}
		}
	}
	if time.Since(started) > compactionMarkerStaleAfter {
		_ = os.Remove(markerPath)
		return false
	}
	return true
}
