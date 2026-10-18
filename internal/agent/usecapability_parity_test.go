package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"reasonix/internal/capability"
	"reasonix/internal/memory"
	"reasonix/internal/tool"
)

// capabilityParityStubTool stands in for a registry tool when the test only
// needs its name and contract shape.
type capabilityParityStubTool struct{ name string }

func (s capabilityParityStubTool) Name() string        { return s.name }
func (s capabilityParityStubTool) Description() string { return "stub " + s.name }
func (s capabilityParityStubTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object"}`)
}
func (s capabilityParityStubTool) ReadOnly() bool { return true }
func (s capabilityParityStubTool) Execute(context.Context, json.RawMessage) (string, error) {
	return "", nil
}

// useCapabilityParityFixture builds a proxy whose catalog matches its registry,
// so a mismatch between call and inspect resolution shows up as a real defect
// instead of a missing-tool artifact. The catalog uses AllContractEntries, the
// same source boot uses, so hidden tools stay in scope.
func useCapabilityParityFixture(t *testing.T) *UseCapabilityTool {
	t.Helper()
	reg := tool.NewRegistry()
	store := memory.Store{Dir: t.TempDir()}
	for _, tl := range []tool.Tool{
		memory.NewRecallTool(store),
		memory.NewRememberTool(store),
		memory.NewForgetTool(store),
	} {
		reg.Add(tl)
	}
	catalog := func() capability.Catalog {
		return capability.Catalog{Entries: capability.ToolEntries(reg.AllContractEntries())}
	}
	return NewUseCapabilityTool(context.Background(), nil, nil, reg, nil, nil, catalog)
}

// resolveOutcome reports whether an action reached a dispatchable capability.
// A call that resolves to Unavailable counts as failure: it only swallows the
// error so the model can read the reason.
func resolveOutcome(t *testing.T, proxy *UseCapabilityTool, action, id string) bool {
	t.Helper()
	args := json.RawMessage(fmt.Sprintf(`{"action":%q,"capability_id":%q,"arguments":{}}`, action, id))
	res, err := proxy.ResolveCall(context.Background(), args)
	if action == "inspect" {
		return err == nil
	}
	return err == nil && !res.Unavailable
}

// call and inspect must agree on whether an advertised id exists. They used to
// disagree: call stripped namespace prefixes and special-cased task:/workflow:,
// while inspect matched the catalog verbatim, so the same id worked for one
// action and reported "unknown capability_id" for the other.
func TestUseCapabilityCallAndInspectAgreeOnAdvertisedIDs(t *testing.T) {
	proxy := useCapabilityParityFixture(t)

	for _, id := range []string{
		"tool:remember", "tool:forget", "tool:memory",
		"memory:remember", "memory:forget", "memory:memory",
		"workflow:remember",
		"web:remember", "lsp:remember", "session:remember",
	} {
		t.Run(id, func(t *testing.T) {
			callOK := resolveOutcome(t, proxy, "call", id)
			inspectOK := resolveOutcome(t, proxy, "inspect", id)
			if !callOK {
				t.Fatalf("%q is not dispatchable via call, so it must not be advertised", id)
			}
			if !inspectOK {
				t.Fatalf("%q dispatches via call but inspect reports it unknown", id)
			}
		})
	}
}

// task: ids are aliases: resolveCall maps task:subagent to the task tool. inspect
// has to follow the same alias table or it reports them unknown.
func TestUseCapabilityCallAndInspectAgreeOnTaskAliases(t *testing.T) {
	reg := tool.NewRegistry()
	for _, name := range []string{"task", "read_only_task", "parallel_tasks", "fleet"} {
		reg.Add(capabilityParityStubTool{name: name})
	}
	catalog := func() capability.Catalog {
		return capability.Catalog{Entries: capability.ToolEntries(reg.AllContractEntries())}
	}
	proxy := NewUseCapabilityTool(context.Background(), nil, nil, reg, nil, nil, catalog)

	for _, tc := range []struct{ id, target string }{
		{"task:subagent", "task"},
		{"task:task", "task"},
		{"task:fleet", "fleet"},
		{"task:parallel", "parallel_tasks"},
		{"task:read_only_subagent", "read_only_task"},
		{"task:research", "read_only_task"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			args := json.RawMessage(fmt.Sprintf(`{"action":"call","capability_id":%q,"arguments":{}}`, tc.id))
			res, err := proxy.ResolveCall(context.Background(), args)
			if err != nil || res.Unavailable {
				t.Fatalf("%q is not dispatchable: err=%v reason=%q", tc.id, err, res.UnavailableReason)
			}
			if res.TargetName != tc.target {
				t.Fatalf("%q resolved to %q, want %q", tc.id, res.TargetName, tc.target)
			}
			if !resolveOutcome(t, proxy, "inspect", tc.id) {
				t.Fatalf("%q dispatches but inspect reports it unknown", tc.id)
			}
		})
	}
}

// Unknown names must fail on both actions: a permissive inspect that answered
// for anything would hide typos instead of surfacing them.
func TestUseCapabilityCallAndInspectRejectUnknownIDsTogether(t *testing.T) {
	proxy := useCapabilityParityFixture(t)

	for _, id := range []string{"tool:no_such_tool", "memory:no_such_tool", "skill:no-such-skill", "mcp-tool:gh/no_such"} {
		t.Run(id, func(t *testing.T) {
			if resolveOutcome(t, proxy, "call", id) {
				t.Fatalf("%q unexpectedly dispatchable", id)
			}
			if resolveOutcome(t, proxy, "inspect", id) {
				t.Fatalf("%q unexpectedly inspectable", id)
			}
		})
	}
}
