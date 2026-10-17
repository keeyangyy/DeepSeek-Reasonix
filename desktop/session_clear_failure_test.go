package main

import (
	"errors"
	"testing"

	"reasonix/internal/control"
	"reasonix/internal/provider"
)

// failingClearController makes the rotation itself fail so the desktop layer
// can be pinned to the contract the frontend now depends on: a refused clear is
// reported as an error and leaves the tab's published session identity intact.
type failingClearController struct {
	*tabScopedActionController
	clearErr error
	calls    int
}

func (c *failingClearController) ClearSession() error {
	c.calls++
	if c.clearErr != nil {
		return c.clearErr
	}
	return c.tabScopedActionController.ClearSession()
}

func newClearFailureApp(t *testing.T, ctrl *failingClearController) (*App, *WorkspaceTab) {
	t.Helper()
	isolateDesktopUserDirs(t)
	tab := &WorkspaceTab{ID: "target", Scope: "global", Ready: true, Ctrl: ctrl, disabledMCP: map[string]ServerView{}}
	app := &App{
		tabs:        map[string]*WorkspaceTab{"target": tab},
		tabOrder:    []string{"target"},
		activeTabID: "target",
	}
	return app, tab
}

// TestClearSessionForTabSurfacesControllerFailure pins the backend half of the
// /clear contract. The frontend used to swallow this error and report success;
// it now rethrows, so the error must reach it unchanged and the tab must still
// describe the unchanged session (same generation, same path) for the
// authoritative re-read the frontend performs on failure.
func TestClearSessionForTabSurfacesControllerFailure(t *testing.T) {
	failErr := errors.New("cannot clear while a turn is running: turn running")
	ctrl := &failingClearController{tabScopedActionController: newTabScopedActionController(), clearErr: failErr}
	app, tab := newClearFailureApp(t, ctrl)
	beforeGen := tab.SessionGeneration
	beforePath := tab.currentSessionPath()

	if _, err := app.ClearSessionForTab("target"); !errors.Is(err, failErr) {
		t.Fatalf("ClearSessionForTab error = %v, want the controller failure", err)
	}
	if ctrl.calls != 1 {
		t.Fatalf("controller ClearSession calls = %d, want 1", ctrl.calls)
	}
	if tab.SessionGeneration != beforeGen {
		t.Fatalf("session generation changed on a failed clear: %d -> %d", beforeGen, tab.SessionGeneration)
	}
	if tab.currentSessionPath() != beforePath {
		t.Fatalf("session path changed on a failed clear: %q -> %q", beforePath, tab.currentSessionPath())
	}
}

// TestClearSessionForTabRetriesAfterFailure proves a failed clear is not a
// one-way door: once the controller accepts the rotation, the same call
// succeeds and does publish the replacement identity.
func TestClearSessionForTabRetriesAfterFailure(t *testing.T) {
	ctrl := &failingClearController{tabScopedActionController: newTabScopedActionController(), clearErr: errors.New("boom")}
	app, tab := newClearFailureApp(t, ctrl)
	beforeGen := tab.SessionGeneration

	if _, err := app.ClearSessionForTab("target"); err == nil {
		t.Fatal("first clear must fail")
	}
	ctrl.clearErr = nil
	// Restore conversational content so the successful retry exercises the
	// non-blank rotation path.
	ctrl.history = append(ctrl.history, provider.Message{Role: provider.RoleUser, Content: "clear me after the retry"})

	result, err := app.ClearSessionForTab("target")
	if err != nil {
		t.Fatalf("retry ClearSessionForTab: %v", err)
	}
	if ctrl.calls != 2 {
		t.Fatalf("controller ClearSession calls = %d, want 2", ctrl.calls)
	}
	// The stub controller owns no session directory, so the published path
	// stays empty here; the identity contract under test is the generation.
	if result.SessionGeneration <= beforeGen {
		t.Fatalf("retry generation = %d, want > %d", result.SessionGeneration, beforeGen)
	}
	if tab.SessionGeneration != result.SessionGeneration {
		t.Fatalf("tab generation = %d, result = %d", tab.SessionGeneration, result.SessionGeneration)
	}
}

// statusOnlyController reports a fixed runtime status so the state → clear path
// mapping can be pinned without booting a real controller.
type statusOnlyController struct {
	stubSessionAPI
	status control.RuntimeStatus
}

func (c statusOnlyController) RuntimeStatus() control.RuntimeStatus { return c.status }

// TestClearSessionStateClassification pins which runtime states route /clear
// through cancel-and-rebuild (clearActiveSessionRuntime) instead of the
// in-place controller rotation. A running turn, a turn waiting on a user
// decision, and running background jobs all take the rebuild path, which also
// covers a running tool or subagent turn because both run inside that turn.
func TestClearSessionStateClassification(t *testing.T) {
	cases := []struct {
		name   string
		status control.RuntimeStatus
		want   bool
	}{
		{"idle", control.RuntimeStatus{}, false},
		{"generating", control.RuntimeStatus{Running: true}, true},
		{"waiting for approval", control.RuntimeStatus{PendingPrompt: true}, true},
		{"tool or background job running", control.RuntimeStatus{BackgroundJobs: 1}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := controllerHasActiveRuntimeWork(statusOnlyController{status: tc.status}); got != tc.want {
				t.Fatalf("controllerHasActiveRuntimeWork(%+v) = %t, want %t", tc.status, got, tc.want)
			}
		})
	}
}
