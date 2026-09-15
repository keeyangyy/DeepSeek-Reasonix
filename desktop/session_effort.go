package main

import (
	"log/slog"
	"strings"

	"reasonix/internal/agent"
)

// sessionEffortFor resolves the reasoning level a conversation owns. A missing
// or empty record means auto, so switching conversations never revives the
// level the visible tab carried over from the previous one.
func sessionEffortFor(sessionPath string) *string {
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		return nil
	}
	return effortPtr(meta.Effort)
}

// effortPtr converts a stored level into a tab override. An empty record means
// auto (no override) rather than a pinned empty value.
func effortPtr(level string) *string {
	trimmed := strings.TrimSpace(level)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// effortString renders a tab override for the sidecar field, mapping a nil
// (auto) override back to the empty string.
func effortString(level *string) string {
	if level == nil {
		return ""
	}
	return strings.TrimSpace(*level)
}

// recordTabSessionEffort mirrors the tab's level into the session sidecar,
// which is what a later conversation switch reads back.
func recordTabSessionEffort(a *App, tab *WorkspaceTab, path string) {
	if a == nil || tab == nil {
		return
	}
	a.mu.RLock()
	level := effortString(tab.effort)
	ctrl := tab.Ctrl
	a.mu.RUnlock()
	path = strings.TrimSpace(path)
	if path == "" && ctrl != nil {
		path = strings.TrimSpace(ctrl.SessionPath())
	}
	if path == "" {
		return
	}
	if err := agent.SetBranchEffortPreserveUpdated(path, level); err != nil {
		slog.Warn("desktop: persist session effort failed", "path", path, "err", err)
	}
}

// alignEffortForReusedRuntime repoints a tab that reattached an existing
// runtime at the target session's own level: the reused runtime already
// belongs to that session, but the tab mirror still describes the outgoing one.
func (a *App) alignEffortForReusedRuntime(tab *WorkspaceTab, sessionPath string) {
	level := sessionEffortFor(sessionPath)
	a.mu.Lock()
	defer a.mu.Unlock()
	if tab == nil || tab.removed || a.tabs[tab.ID] != tab {
		return
	}
	tab.effort = level
	a.saveTabsLocked()
}
