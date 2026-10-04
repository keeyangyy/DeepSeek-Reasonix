package control

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"reasonix/internal/base/testenv"
	"reasonix/internal/state/memory"
)

// TestAllowRememberByScopeFollowsTheSwitchAndTheScope is the switch's contract:
// each answer covers its own scope only, both off keeps the dialog, and the
// scope comes from the call rather than from a guess.
func TestAllowRememberByScopeFollowsTheSwitchAndTheScope(t *testing.T) {
	root := testenv.TempDir(t)
	c := &Controller{controllerDeps: controllerDeps{
		memory: newMemoryManager(&memory.Set{Store: memory.Store{
			Dir: filepath.Join(root, "project"), GlobalDir: filepath.Join(root, "global"),
		}}),
	}}

	project := json.RawMessage(`{"name":"fact","scope":"project","description":"d","body":"b"}`)
	global := json.RawMessage(`{"name":"fact","scope":"global","description":"d","body":"b"}`)
	unsaid := json.RawMessage(`{"name":"fact","description":"d","body":"b"}`)

	if c.allowRememberByScope(project) || c.allowRememberByScope(global) {
		t.Fatal("both switches off: nothing may pass without asking")
	}

	c.autoConfirmProjectRemember = true
	if !c.allowRememberByScope(project) || !c.allowRememberByScope(unsaid) {
		t.Fatal("project switch on: a project write must pass")
	}
	if c.allowRememberByScope(global) {
		t.Fatal("project switch must not cover a global write")
	}

	c.autoConfirmProjectRemember, c.autoConfirmGlobalRemember = false, true
	if !c.allowRememberByScope(global) {
		t.Fatal("global switch on: a global write must pass")
	}
	if c.allowRememberByScope(project) {
		t.Fatal("global switch must not cover a project write")
	}
}
