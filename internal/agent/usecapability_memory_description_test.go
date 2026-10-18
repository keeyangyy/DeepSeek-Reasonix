package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"reasonix/internal/capability"
	"reasonix/internal/memory"
	"reasonix/internal/tool"
)

func TestUseCapabilityMemoryDescriptionNamesRoutableTools(t *testing.T) {
	reg := tool.NewRegistry()
	store := memory.Store{Dir: t.TempDir()}
	for _, tl := range []tool.Tool{
		memory.NewRecallTool(store),
		memory.NewRememberTool(store),
		memory.NewForgetTool(store),
	} {
		reg.Add(tl)
	}
	proxy := NewUseCapabilityTool(context.Background(), nil, nil, reg, nil, nil, nil)
	description := proxy.Description()
	if strings.Contains(description, "memory:recall") {
		t.Fatal("description must not advertise the unregistered memory:recall route")
	}
	for _, contract := range []string{
		"description+body required",
		`activation="relevant" on create`,
		"omit activation on update",
		`"pinned" only if user asks`,
		"memory:forget(name)",
		"tool:memory(operation=search|read|list)",
	} {
		if !strings.Contains(description, contract) {
			t.Errorf("description does not document %q", contract)
		}
	}

	for id, wantTarget := range map[string]string{
		"memory:remember": "remember",
		"memory:forget":   "forget",
		"tool:memory":     "memory",
	} {
		t.Run(id, func(t *testing.T) {
			if !strings.Contains(description, id) {
				t.Fatalf("description does not advertise %q", id)
			}
			call := json.RawMessage(fmt.Sprintf(`{"action":"call","capability_id":%q,"arguments":{}}`, id))
			resolved, err := proxy.ResolveCall(context.Background(), call)
			if err != nil {
				t.Fatalf("ResolveCall(%q): %v", id, err)
			}
			if resolved.Target == nil || resolved.TargetName != wantTarget {
				t.Fatalf("ResolveCall(%q) target = %q, want %q", id, resolved.TargetName, wantTarget)
			}
		})
	}
}

// Every id the description advertises must also be inspectable. inspect used to
// match the catalog verbatim while call stripped the namespace prefix, so the
// SAME id worked for call and failed with "unknown capability_id" for inspect.
func TestUseCapabilityInspectAcceptsAdvertisedMemoryIDs(t *testing.T) {
	reg := tool.NewRegistry()
	store := memory.Store{Dir: t.TempDir()}
	var contracts []tool.ContractEntry
	for _, tl := range []tool.Tool{
		memory.NewRecallTool(store),
		memory.NewRememberTool(store),
		memory.NewForgetTool(store),
	} {
		reg.Add(tl)
		contracts = append(contracts, reg.ContractEntries()...)
	}
	catalog := func() capability.Catalog {
		return capability.Catalog{Entries: capability.ToolEntries(contracts)}
	}
	proxy := NewUseCapabilityTool(context.Background(), nil, nil, reg, nil, nil, catalog)

	for _, id := range []string{"memory:remember", "memory:forget", "tool:memory", "tool:remember"} {
		t.Run(id, func(t *testing.T) {
			call := json.RawMessage(fmt.Sprintf(`{"action":"inspect","capability_id":%q}`, id))
			resolved, err := proxy.ResolveCall(context.Background(), call)
			if err != nil {
				t.Fatalf("inspect(%q) rejected an advertised id: %v", id, err)
			}
			if !strings.Contains(resolved.Result, `"id": "`+canonicalCapabilityID(id)+`"`) {
				t.Fatalf("inspect(%q) reported a different id:\n%s", id, resolved.Result)
			}
		})
	}
}
