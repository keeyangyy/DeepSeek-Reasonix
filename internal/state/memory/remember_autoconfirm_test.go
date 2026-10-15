package memory

import (
	"encoding/json"
	"testing"

	"reasonix/internal/base/testenv"
)

// The switch lifts the ask for the scope it covers, not the content floor: a
// body that reads as a credential or an address keeps asking however it is set.
func TestAssessRememberSwitchKeepsTheContentFloor(t *testing.T) {
	store := Store{Dir: testenv.TempDir(t), GlobalDir: testenv.TempDir(t)}
	safe := json.RawMessage(`{"name":"release-target","scope":"project","description":"Release target","type":"project","body":"Release artifacts are published from main-v2."}`)
	if got := AssessRememberSwitch(store, safe); !got.AutoAllow || got.Name != "release-target" {
		t.Fatalf("safe write assessment = %+v", got)
	}

	sensitive := map[string]json.RawMessage{
		"credential": json.RawMessage(`{"name":"deploy-key","scope":"project","description":"Deploy","body":"DEPLOY_API_KEY=sk-example-secret-value-123456"}`),
		"email":      json.RawMessage(`{"name":"release-owner","scope":"project","description":"Release owner","body":"Contact release-owner@example.test."}`),
	}
	for name, args := range sensitive {
		t.Run(name, func(t *testing.T) {
			if got := AssessRememberSwitch(store, args); got.AutoAllow || got.Reason == "" {
				t.Fatalf("sensitive write assessment = %+v, want asking", got)
			}
		})
	}
}

// An id-only call still has a name to report: the stored fact's own, so the
// receipt it owes can name the fact /forget takes back.
func TestAssessRememberSwitchNamesAnIdOnlyUpdate(t *testing.T) {
	store := Store{Dir: testenv.TempDir(t), GlobalDir: testenv.TempDir(t)}
	if _, err := store.Save(Memory{
		Name: "release-target", Type: TypeProject, Scope: FactScopeProject,
		Description: "Release target", Body: "Release from main.",
	}); err != nil {
		t.Fatal(err)
	}
	stored, ok, err := store.Read("release-target")
	if err != nil || !ok {
		t.Fatalf("stored fact was not readable: ok=%v err=%v", ok, err)
	}
	got := AssessRememberSwitch(store, json.RawMessage(`{"id":"`+stored.ID+`","description":"Release target","body":"Release from main-v2."}`))
	if !got.AutoAllow || got.Name != "release-target" {
		t.Fatalf("id-only update assessment = %+v", got)
	}
}

// RememberWriteScope answers from the call itself: an explicit scope, a
// qualified name, the silent project default, and args that cannot be read.
func TestRememberWriteScopeAnswersFromTheCallItself(t *testing.T) {
	root := testenv.TempDir(t)
	store := Store{Dir: root + "/project", GlobalDir: root + "/global"}
	cases := []struct {
		name string
		args string
		want FactScope
	}{
		{"explicit global", `{"name":"fact","scope":"global","description":"d","body":"b"}`, FactScopeGlobal},
		{"explicit project", `{"name":"fact","scope":"project","description":"d","body":"b"}`, FactScopeProject},
		{"scope left out reads as project", `{"name":"fact","description":"d","body":"b"}`, FactScopeProject},
		{"qualified name wins", `{"name":"global/fact.md","description":"d","body":"b"}`, FactScopeGlobal},
		{"unparsable args read as project", `not json`, FactScopeProject},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RememberWriteScope(store, json.RawMessage(tc.args)); got != tc.want {
				t.Fatalf("RememberWriteScope(%s) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

// An update that leaves scope out is answered by the fact it rewrites, not by
// the default: that is what keeps a global memory off the project switch.
func TestRememberWriteScopeFollowsTheStoredFactOnUpdate(t *testing.T) {
	root := testenv.TempDir(t)
	store := Store{Dir: root + "/project", GlobalDir: root + "/global"}
	if _, err := store.Save(Memory{Name: "global/keep.md", Description: "d", Body: "b"}); err != nil {
		t.Fatal(err)
	}
	stored, ok, err := store.Read("global/keep.md")
	if err != nil || !ok || stored.ID == "" {
		t.Fatalf("global fact not readable with an id: %+v, ok=%v err=%v", stored, ok, err)
	}
	args, err := json.Marshal(map[string]any{"id": stored.ID, "name": "keep.md", "description": "d", "body": "b2"})
	if err != nil {
		t.Fatal(err)
	}
	if got := RememberWriteScope(store, args); got != FactScopeGlobal {
		t.Fatalf("RememberWriteScope(update without scope) = %q, want %q", got, FactScopeGlobal)
	}
}
