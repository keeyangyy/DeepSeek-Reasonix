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

// errSessionTopicTitleUnchanged lets writeSessionTopicTitle skip a sidecar
// rewrite when the session already carries the committed title.
var errSessionTopicTitleUnchanged = errors.New("session topic title unchanged")

// writeSessionTopicTitle mirrors a topic-layer title onto one session sidecar.
//
// The session list, tab strip, and history panel render the per-session copy of
// the title, and the session-catalog projection indexes it. Auto-naming used to
// write only the topic layer, so an auto-named conversation kept showing the
// localized placeholder ("新的会话") in those views until the user renamed it by
// hand — the topic layer had the real name while the sidecar kept the default.
// updateTopicSessionTitles cannot close that gap reliably: it finds its targets
// by scanning known session directories for a topic match, so a session whose
// directory is not in that set (or whose sidecar lock is held) is skipped
// silently. Callers that already know the exact session path pass it here.
func writeSessionTopicTitle(sessionPath, title string) error {
	sessionPath = strings.TrimSpace(sessionPath)
	title = strings.TrimSpace(title)
	if sessionPath == "" || title == "" {
		return nil
	}
	return agent.UpdateBranchMeta(sessionPath, false, func(meta *agent.BranchMeta) error {
		if strings.TrimSpace(meta.TopicTitle) == title {
			return errSessionTopicTitleUnchanged
		}
		meta.TopicTitle = title
		return nil
	})
}

// commitAutoTopicTitle publishes a committed auto title to the open tab and to
// the session sidecar. The topic layer alone leaves the session list, tab strip
// and history panel on the placeholder label: those views read the sidecar.
func (a *App) commitAutoTopicTitle(sessionPath, topicID, title string) {
	a.updateOpenTopicTitle(topicID, title, topicTitleSourceAuto)
	if err := writeSessionTopicTitle(sessionPath, title); err != nil && !errors.Is(err, errSessionTopicTitleUnchanged) {
		slog.Warn("desktop: auto-title session sidecar sync failed", "topic", topicID, "error_type", topicStateErrorType(err))
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
