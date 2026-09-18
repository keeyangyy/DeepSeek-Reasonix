package main

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"reasonix/internal/agent"
)

// propagateSessionCustomTitleToTopic lifts a session's canonical custom title
// into the topic layer (state store + in-memory tabs) so the sidebar topic
// label follows explicit renames. The sidebar reads TopicTitle while rename
// paths only wrote CustomTitle, leaving the visible label stale (repro:
// AIRenameSession showed a success toast but the tree did not change).
// An explicit rename is manual by definition, so the source becomes
// topicTitleSourceManual, which also retires auto-rename for that topic —
// the same contract as RenameTopic.
//
// Topic identity is resolved from live tabs first (a renamed session is
// usually open), then from the session sidecar's TopicID/Scope/WorkspaceRoot
// metadata. When neither carries the topic binding, the rename stays
// session-scoped and there is no topic label to update.
func (a *App) propagateSessionCustomTitleToTopic(sessionPath, fallbackTopicID string) {
	sessionPath = strings.TrimSpace(sessionPath)
	if sessionPath == "" {
		return
	}
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		return
	}
	title := strings.TrimSpace(meta.CustomTitle)
	if title == "" {
		return
	}
	topicID := strings.TrimSpace(meta.TopicID)
	scope := strings.TrimSpace(meta.Scope)
	workspaceRoot := ""
	if topicID == "" {
		topicID = strings.TrimSpace(fallbackTopicID)
		if topicID == "" {
			return
		}
		var ok bool
		scope, _, ok = a.findTopicLocation(topicID)
		if !ok {
			scope = ""
		}
	}
	topicID = strings.TrimSpace(topicID)
	if topicID == "" {
		return
	}
	if scope == "project" {
		workspaceRoot = normalizeProjectRoot(strings.TrimSpace(meta.WorkspaceRoot))
		if workspaceRoot == "" {
			_, workspaceRoot, _ = a.findTopicLocation(topicID)
		}
	} else {
		workspaceRoot = ""
	}
	a.mu.RLock()
	observedSource := topicTitleSourceManual
	for _, tab := range a.runtimeTabsLocked() {
		if tab != nil && strings.TrimSpace(tab.TopicID) == topicID {
			// A concurrent RenameTopic on the same topic already holds
			// topicTitleMutationMu; mirror its current source instead of
			// downgrading it.
			observedSource = tab.topicTitleSource
			break
		}
	}
	a.mu.RUnlock()
	if observedSource != topicTitleSourceManual {
		observedSource = topicTitleSourceManual
	}
	if err := setTopicTitleWithSource(workspaceRoot, topicID, title, observedSource); err != nil {
		slog.Warn("desktop: session rename topic title sync failed", "scope", topicScopeKind(workspaceRoot), "error_type", topicStateErrorType(err))
		return
	}
	a.updateOpenTopicTitle(topicID, title, observedSource)
	// The rename path emitted a tree refresh before this propagation ran, so
	// that snapshot still carried the stale topic label. Emit again now that
	// the topic layer is current (mirrors the tail of RenameTopic).
	changedDirs := a.updateTopicSessionTitles(topicID, title)
	if len(changedDirs) > 0 {
		a.emitProjectTreeChangedForSessionDirs(changedDirs...)
	} else {
		a.emitProjectTreeMetadataChanged()
	}
}

// autoTitleGateLog records why an auto-title pass could not name its topic.
// These paths used to be fully silent, so a stuck "新的会话" label was
// undiagnosable; the Warn rate is bounded by once per gate per process, which
// keeps routine stage-locked skips quiet while still leaving a durable trace
// for transient failures (topic-state read fallbacks, event-log replay
// limits) on the diagnostic log.
var autoTitleGateLogged sync.Map

func autoTitleGateLog(gate string, kind string) {
	if _, loaded := autoTitleGateLogged.LoadOrStore(gate, struct{}{}); loaded {
		return
	}
	slog.Warn("desktop: auto-title gate skipped topic naming", "gate", gate, "error_type", kind)
}

// errorKindForAutoTitleLog reduces an error to a bounded, low-noise label for
// the auto-title gate log.
func errorKindForAutoTitleLog(err error) string {
	var limit *agent.SessionReplayLimitError
	switch {
	case errors.As(err, &limit):
		return "session-replay-limit"
	case errors.Is(err, os.ErrNotExist):
		return "session-missing"
	default:
		return "read-error"
	}
}

// sessionCustomTitleForLabel returns the session's canonical custom title for
// sidebar labels: BranchMeta.CustomTitle first, then the legacy titles map.
// Empty when the session has no explicit name, so callers can fall back to
// the file-name label.
func sessionCustomTitleForLabel(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if meta, ok, err := agent.LoadBranchMeta(path); err == nil && ok {
		if title := strings.TrimSpace(meta.CustomTitle); title != "" {
			return title
		}
	}
	dir := filepath.Dir(path)
	if dir == "." || dir == string(filepath.Separator) {
		return ""
	}
	return strings.TrimSpace(loadSessionTitles(dir)[filepath.Base(path)])
}
