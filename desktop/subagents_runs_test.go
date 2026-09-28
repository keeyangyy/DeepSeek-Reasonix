package main

import (
	"path/filepath"
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/tool"
)

// A settled session's transcript records only the dispatching call, so the
// sub-agent panel gets the nesting and settled outcome from the run sidecars.
// This locks that binding: it must report the dispatching call id, the settled
// status and the dispatch model for every run owned by the tab's session, and
// must never leak another session's runs.
func TestListSubagentsForTabProjectsPersistedRuns(t *testing.T) {
	sessionDir := t.TempDir()
	parentSession := "parent-session"
	parentPath := filepath.Join(sessionDir, parentSession+".jsonl")

	app := NewApp()
	tab := &WorkspaceTab{ID: "tab-subagents", SessionPath: parentPath}
	app.tabs[tab.ID] = tab

	store := agent.NewSubagentStore(filepath.Join(sessionDir, "subagents"))
	for _, spec := range []agent.SubagentSpec{
		{
			Kind: "task", Name: "task", WorkspaceRoot: t.TempDir(),
			ParentSession: parentSession, ParentToolCallID: "call_00_fleet/fleet-1",
			SystemPrompt: "sys", Registry: tool.NewRegistry(), Model: "m-1", Effort: "high",
		},
		{
			Kind: "task", Name: "task", WorkspaceRoot: t.TempDir(),
			ParentSession: parentSession, ParentToolCallID: "call_00_fleet/fleet-2",
			SystemPrompt: "sys", Registry: tool.NewRegistry(), Model: "m-2",
		},
	} {
		run, err := store.PrepareFresh(spec)
		if err != nil {
			t.Fatalf("PrepareFresh: %v", err)
		}
		if err := store.MarkRunning(run); err != nil {
			t.Fatalf("MarkRunning: %v", err)
		}
		run.Release()
	}
	// A run owned by a different session must not appear in this tab's list.
	foreign, err := store.PrepareFresh(agent.SubagentSpec{
		Kind: "task", Name: "task", WorkspaceRoot: t.TempDir(),
		ParentSession: "someone-else", ParentToolCallID: "call_ff_other",
		SystemPrompt: "sys", Registry: tool.NewRegistry(),
	})
	if err != nil {
		t.Fatalf("PrepareFresh(foreign): %v", err)
	}
	if err := store.MarkRunning(foreign); err != nil {
		t.Fatalf("MarkRunning(foreign): %v", err)
	}
	foreign.Release()

	runs := app.ListSubagentsForTab(tab.ID)
	if len(runs) != 2 {
		t.Fatalf("ListSubagentsForTab returned %d runs, want 2: %+v", len(runs), runs)
	}
	byParent := map[string]SubagentRunView{}
	for _, run := range runs {
		byParent[run.ParentToolCallID] = run
		if run.Status == "" || run.Kind == "" || run.Name == "" {
			t.Fatalf("run %+v is missing its identity fields", run)
		}
	}
	child, ok := byParent["call_00_fleet/fleet-1"]
	if !ok {
		t.Fatalf("fleet child run missing; got %+v", runs)
	}
	if child.Model != "m-1" || child.Effort != "high" {
		t.Fatalf("dispatch model/effort not projected: %+v", child)
	}
	if child.CreatedAt == "" || child.UpdatedAt == "" {
		t.Fatalf("run must carry timestamps, got %+v", child)
	}
	if _, ok := byParent["call_ff_other"]; ok {
		t.Fatalf("another session's run leaked into the list: %+v", runs)
	}
}

func TestListSubagentsForTabWithoutSessionIsEmpty(t *testing.T) {
	app := NewApp()
	tab := &WorkspaceTab{ID: "tab-no-session"}
	app.tabs[tab.ID] = tab
	if runs := app.ListSubagentsForTab(tab.ID); len(runs) != 0 {
		t.Fatalf("a tab with no session must list nothing, got %+v", runs)
	}
	if runs := app.ListSubagentsForTab("missing-tab"); len(runs) != 0 {
		t.Fatalf("an unknown tab must list nothing, got %+v", runs)
	}
}
