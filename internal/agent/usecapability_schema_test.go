package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The schema is a hand-written raw string literal, so a stray quote breaks the
// tool contract at runtime while still compiling. Parse it here.
func TestUseCapabilitySchemaIsValidJSON(t *testing.T) {
	proxy := NewUseCapabilityTool(context.Background(), nil, nil, nil, nil, nil, nil)
	raw := proxy.Schema()

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("use_capability schema is not valid JSON: %v\n%s", err, raw)
	}
	props, ok := decoded["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema has no properties object:\n%s", raw)
	}
	args, ok := props["arguments"].(map[string]any)
	if !ok {
		t.Fatalf("schema has no arguments property:\n%s", raw)
	}
	desc, _ := args["description"].(string)
	if desc == "" {
		t.Fatalf("arguments has no description:\n%s", raw)
	}
	// arguments carries every capability kind's payload, not just MCP's. A
	// description claiming MCP-only semantics makes the model skip the field for
	// skills and tools, which then fail with a missing-input error.
	if strings.Contains(strings.ToLower(desc), "mcp") {
		t.Fatalf("arguments description still claims MCP-only semantics: %q", desc)
	}
}
