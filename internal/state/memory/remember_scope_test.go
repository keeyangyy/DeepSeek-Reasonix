package memory

import (
	"encoding/json"
	"testing"

	"reasonix/internal/base/testenv"
)

// TestRememberWriteScopeAnswersFromTheCallItself pins what the approval
// switches split on: an explicit scope, a qualified name, the silent project
// default, and args that cannot be read at all.
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

// TestRememberWriteScopeFollowsTheStoredFactOnUpdate is the case that keeps a
// global memory from riding the project switch: an update that leaves scope out
// is answered by the fact it rewrites, not by the default.
func TestRememberWriteScopeFollowsTheStoredFactOnUpdate(t *testing.T) {
	root := testenv.TempDir(t)
	store := Store{Dir: root + "/project", GlobalDir: root + "/global"}
	if _, err := store.SaveWithOptions(Memory{Name: "global/keep.md", Description: "d", Body: "b"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	stored, ok := store.Read("global/keep.md")
	if !ok || stored.ID == "" {
		t.Fatalf("global fact not readable with an id: %+v, ok=%v", stored, ok)
	}
	args, err := json.Marshal(map[string]any{"id": stored.ID, "name": "keep.md", "description": "d", "body": "b2"})
	if err != nil {
		t.Fatal(err)
	}
	if got := RememberWriteScope(store, args); got != FactScopeGlobal {
		t.Fatalf("RememberWriteScope(update without scope) = %q, want %q", got, FactScopeGlobal)
	}
}
