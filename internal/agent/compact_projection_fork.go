package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reasonix/internal/store"
	"strconv"
	"time"
)

// writeCompactionSidecar manages the session compaction sidecar
// (<session>.ckpt/): a "compacting.json" in-progress marker and the finished
// "latest-compaction.json" record. It lives in the agent so a compaction that
// finishes after its tab was released (switch-away mid-run) still persists —
// the controller's own sessionPath and executor can be cleared by then.
func writeCompactionSidecar(sessionPath, kind string, rec *CompactionRecord) {
	if sessionPath == "" {
		return
	}
	dir := store.SessionCheckpointDir(sessionPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	switch kind {
	case "marker":
		b, _ := json.Marshal(map[string]string{"startedAt": strconv.FormatInt(time.Now().UnixMilli(), 10)})
		_ = os.WriteFile(filepath.Join(dir, "compacting.json"), b, 0o644)
	case "record":
		if rec == nil {
			return
		}
		b, err := json.Marshal(rec)
		if err != nil {
			return
		}
		_ = os.WriteFile(filepath.Join(dir, "latest-compaction.json"), b, 0o644)
		_ = os.Remove(filepath.Join(dir, "compacting.json"))
	case "clear":
		_ = os.Remove(filepath.Join(dir, "compacting.json"))
	}
}

// CompactionRecord is the persisted summary of the most recent compaction.
// It lives in the sidecar so a session re-opened after its tab was released
// (switch-away mid-compact) can still render the compression result.
type CompactionRecord struct {
	Trigger  string `json:"trigger,omitempty"`
	Messages int    `json:"messages"`
	Summary  string `json:"summary"`
}

// setLastCompaction records the receipt (atomic store) for sidecar persistence.
func (a *Agent) setLastCompaction(rec *CompactionRecord) {
	a.lastCompaction.Store(rec)
}

// LastCompaction returns the most recent compaction record, if any.
func (a *Agent) LastCompaction() *CompactionRecord {
	return a.lastCompaction.Load()
}
