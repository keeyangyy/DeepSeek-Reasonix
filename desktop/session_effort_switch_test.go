package main

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/agent"
)

// A conversation owns its reasoning effort: loading the session profile
// restores the level recorded beside the transcript, and a session recorded as
// auto must overwrite a level the tab carried over from another conversation.
func TestTabSessionProfileCarriesSessionEffort(t *testing.T) {
	isolateDesktopUserDirs(t)

	root := t.TempDir()
	path, err := createEmptySessionFile(desktopSessionDir(root), "deepseek-flash/deepseek-v4-flash")
	if err != nil {
		t.Fatalf("createEmptySessionFile: %v", err)
	}
	if err := agent.SetBranchEffortPreserveUpdated(path, "max"); err != nil {
		t.Fatalf("seed session effort: %v", err)
	}

	profile := loadTabSessionProfile(path)
	if profile.effort != "max" {
		t.Fatalf("profile effort = %q, want max", profile.effort)
	}
	tab := testTab("profile-effort", root)
	tab.effort = effortPtr("low")
	applyTabSessionProfile(tab, profile)
	if tab.effort == nil || *tab.effort != "max" {
		t.Fatalf("tab effort = %v, want max", tab.effort)
	}

	// A session recorded as auto must override the tab's carried-over level
	// instead of leaving it behind — that is the conversation-switch bug.
	if err := agent.SetBranchEffortPreserveUpdated(path, ""); err != nil {
		t.Fatalf("clear session effort: %v", err)
	}
	applyTabSessionProfile(tab, loadTabSessionProfile(path))
	if tab.effort != nil {
		t.Fatalf("tab effort after auto = %q, want nil (auto)", *tab.effort)
	}
}

// Setting the level persists it beside the transcript, so a later conversation
// switch restores that choice instead of the tab's stale state.
func TestSetEffortForTabPersistsSessionEffort(t *testing.T) {
	isolateDesktopUserDirs(t)

	root := t.TempDir()
	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}
	tab := testTab("persist-effort", root)
	path, err := createEmptySessionFile(desktopSessionDir(root), tab.model)
	if err != nil {
		t.Fatalf("createEmptySessionFile: %v", err)
	}
	tab.SessionPath = path
	tab.sink = &tabEventSink{tabID: tab.ID, app: app}
	app.tabs = map[string]*WorkspaceTab{tab.ID: tab}
	app.tabOrder = []string{tab.ID}
	app.activeTabID = tab.ID
	t.Cleanup(func() {
		if tab.Ctrl != nil {
			tab.Ctrl.Close()
		}
	})

	if err := app.SetEffortForTab(tab.ID, "max"); err != nil {
		t.Fatalf("SetEffortForTab: %v", err)
	}
	if got, ok := agent.LoadSessionEffort(sessionPathForEffortAssertion(tab)); !ok || got != "max" {
		t.Fatalf("session effort = %q/%v, want max/true", got, ok)
	}
	if err := app.SetEffortForTab(tab.ID, "auto"); err != nil {
		t.Fatalf("SetEffortForTab(auto): %v", err)
	}
	if got, ok := agent.LoadSessionEffort(sessionPathForEffortAssertion(tab)); !ok || got != "" {
		t.Fatalf("session effort after auto = %q/%v, want empty/true", got, ok)
	}
}

// sessionPathForEffortAssertion resolves the path the runtime actually
// committed to: rebuilding a blank session may rotate it onto a fresh path
// inside its own session dir, so assertions must not assume the seeded file.
func sessionPathForEffortAssertion(tab *WorkspaceTab) string {
	if tab.Ctrl != nil {
		if path := strings.TrimSpace(tab.Ctrl.SessionPath()); path != "" {
			return path
		}
	}
	return strings.TrimSpace(tab.SessionPath)
}