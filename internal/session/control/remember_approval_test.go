package control

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"reasonix/internal/base/testenv"
	"reasonix/internal/state/memory"
)

func rememberSwitchController(t *testing.T) *Controller {
	t.Helper()
	root := testenv.TempDir(t)
	return &Controller{controllerDeps: controllerDeps{
		memory: newMemoryManager(&memory.Set{Store: memory.Store{
			Dir: filepath.Join(root, "project"), GlobalDir: filepath.Join(root, "global"),
		}}),
	}}
}

// TestAllowRememberByScopeFollowsTheSwitchAndTheScope is the switch's contract:
// each answer covers its own scope only, both off keeps the dialog, and the
// scope comes from the call rather than from a guess.
func TestAllowRememberByScopeFollowsTheSwitchAndTheScope(t *testing.T) {
	c := rememberSwitchController(t)

	project := json.RawMessage(`{"name":"fact","scope":"project","description":"d","body":"b"}`)
	global := json.RawMessage(`{"name":"fact","scope":"global","description":"d","body":"b"}`)
	unsaid := json.RawMessage(`{"name":"fact","description":"d","body":"b"}`)

	if c.allowRememberByScope(project).AutoAllow || c.allowRememberByScope(global).AutoAllow {
		t.Fatal("both switches off: nothing may pass without asking")
	}

	c.autoConfirmProjectRemember = true
	if !c.allowRememberByScope(project).AutoAllow || !c.allowRememberByScope(unsaid).AutoAllow {
		t.Fatal("project switch on: a project write must pass")
	}
	if c.allowRememberByScope(global).AutoAllow {
		t.Fatal("project switch must not cover a global write")
	}

	c.autoConfirmProjectRemember, c.autoConfirmGlobalRemember = false, true
	if !c.allowRememberByScope(global).AutoAllow {
		t.Fatal("global switch on: a global write must pass")
	}
	if c.allowRememberByScope(project).AutoAllow {
		t.Fatal("global switch must not cover a project write")
	}
}

// TestAllowRememberByScopeKeepsTheContentFloor pins what the switch does not
// lift: a body that reads as a credential or an address still asks however the
// switch is set, and it names why so the dialog can lead with the cause.
func TestAllowRememberByScopeKeepsTheContentFloor(t *testing.T) {
	c := rememberSwitchController(t)
	c.autoConfirmProjectRemember, c.autoConfirmGlobalRemember = true, true

	cases := map[string]json.RawMessage{
		"credential": json.RawMessage(`{"name":"deploy-key","scope":"project","description":"Deploy","body":"DEPLOY_API_KEY=sk-example-secret-value-123456"}`),
		"email":      json.RawMessage(`{"name":"release-owner","scope":"project","description":"Release owner","body":"Contact release-owner@example.test."}`),
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			got := c.allowRememberByScope(args)
			if got.AutoAllow || got.Reason == "" {
				t.Fatalf("sensitive write passed on the switch: %+v", got)
			}
		})
	}
}
