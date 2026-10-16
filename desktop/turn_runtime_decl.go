package main

import (
	"strings"
)

// workspaceNotReady reports whether the tab is in a transient startup window
// (no permanent startup failure yet), so a replay caller can retry later.
func (a *App) workspaceNotReady(tab *WorkspaceTab) bool {
	if tab == nil {
		return true
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if strings.TrimSpace(tab.StartupErr) != "" {
		return false
	}
	if issue := a.sessionRuntimeViewLocked(tab).Issue; issue != nil && strings.TrimSpace(issue.Message) != "" {
		return false
	}
	return true
}
