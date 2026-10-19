package main

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/control"
)

// historyReadModelRebuildBudget bounds the synchronous repair a failing page
// request may perform. A user is waiting on it, so it must not run unbounded.
const historyReadModelRebuildBudget = 30 * time.Second

// rebuildHistoryReadModelOnPageFailure is the recovery hook for a page request
// that just failed. It replays the authoritative event log to refresh the JSONL
// read model and republish a matching display index, so the same request can be
// served immediately afterwards.
//
// This runs synchronously because the caller's retry must succeed in one click.
// That trade-off is acceptable: the repair is bounded (it only touches this one
// session) and the caller falls back to its original error if it cannot help.
//
// Only transcripts this build can replay qualify. A session written by another
// line or a newer build returns an error from the replay, and rewriting its
// read model would corrupt that line's data — so it is left untouched.
//
// It reports whether the read model was republished, meaning a retry is worth
// attempting. false means the caller must surface its original error unchanged.
func rebuildHistoryReadModelOnPageFailure(sessionPath, cause string) bool {
	path := strings.TrimSpace(sessionPath)
	if path == "" {
		return false
	}
	// Fail closed on anything this build cannot replay. repairable=false means
	// the transcript itself is damaged, and an error means it is foreign.
	if _, _, repairable, err := agent.LoadSessionDisplayMessages(path); err != nil || !repairable {
		slog.Warn("desktop: history page failed and the transcript is not repairable here",
			"path", path, "cause", cause, "err", err)
		return false
	}
	// Re-align the sidecar, not just the derived read model: while the sidecar
	// digest disagrees with the transcript every index build writes revision=0,
	// so only RepairSessionListingProjection (which rewrites meta) can restore it.
	ctx, cancel := context.WithTimeout(context.Background(), historyReadModelRebuildBudget)
	defer cancel()
	result, err := agent.RepairSessionListingProjection(ctx, path)
	if err != nil {
		slog.Warn("desktop: history page failed and sidecar re-alignment failed",
			"path", path, "cause", cause, "err", err)
		return false
	}
	if result.Status != agent.SessionListingRepairApplied && result.Status != agent.SessionListingRepairAlreadyCurrent {
		slog.Warn("desktop: history page failed and sidecar re-alignment did not apply",
			"path", path, "cause", cause, "status", string(result.Status))
		return false
	}
	if err := agent.RepairSessionDisplayReadModel(path); err != nil {
		slog.Warn("desktop: history page failed and read-model rebuild failed",
			"path", path, "cause", cause, "err", err)
		return false
	}
	// Record the cause so a future report of this symptom is diagnosable: the
	// page failure itself is the only evidence, and it used to be discarded.
	slog.Warn("desktop: history page failed and the read model was rebuilt",
		"path", path, "cause", cause, "status", string(result.Status),
		"ledgerRepaired", result.LedgerRepaired, "recovered", true)
	return true
}

// coldHistorySliceWithRecovery pages a session and, if the page fails, rebuilds
// the read model once and retries. The original error survives when the retry
// cannot help, so a genuinely broken session still reports its real cause.
func (a *App) coldHistorySliceWithRecovery(sessionDir, sessionPath string, req HistorySliceRequest) HistorySlice {
	slice, err := a.coldHistorySlice(sessionDir, sessionPath, req)
	if err == nil {
		return slice
	}
	slog.Debug("desktop: cold history slice failed", "path", sessionPath, "err", err)
	if !rebuildHistoryReadModelOnPageFailure(sessionPath, err.Error()) {
		return failedHistorySlice(err.Error())
	}
	retried, retryErr := a.coldHistorySlice(sessionDir, sessionPath, req)
	if retryErr != nil {
		return failedHistorySlice(err.Error())
	}
	return retried
}

// retryLiveHistorySliceAfterRebuild mirrors the cold path for a tab with a
// running controller: rebuild, rebuild the page source, then retry once.
// The original error comes back unchanged when the re-aligned model cannot
// serve the page either.
func (a *App) retryLiveHistorySliceAfterRebuild(ctrl control.SessionAPI, sessionDir, sessionPath string, req HistorySliceRequest, resolver func(string) string, cause error) (HistorySlice, bool, error) {
	if !rebuildHistoryReadModelOnPageFailure(sessionPath, cause.Error()) {
		return HistorySlice{}, false, cause
	}
	healed, healedIndexUsed := a.liveHistorySliceSource(ctrl, sessionPath, resolver)
	if healed == nil {
		return HistorySlice{}, false, cause
	}
	retried, err := a.pageHistorySliceSource(healed, req, resolver, sessionPlannerDisplayTurns(sessionDir, sessionPath), ctrl.CheckpointTurnsByMessageIndex(), sessionPath)
	if err != nil {
		return HistorySlice{}, false, cause
	}
	return retried, healedIndexUsed, nil
}
