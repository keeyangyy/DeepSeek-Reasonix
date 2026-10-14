package agent

import (
	"strings"
	"testing"

	"reasonix/internal/tool"
)

// TestReadOnlyExecutionAllowsSearchDiscovery covers the regression fix: a
// read-only agent may run use_capability's search action because discovery
// resolves locally and never executes the target, so it must pass through
// unblocked with the search results as output.
func TestReadOnlyExecutionAllowsSearchDiscovery(t *testing.T) {
	out := executeReadOnlyBoundaryCall(t, tool.ResolvedCall{
		ProxyAction: "search", SkipExecute: true, ReadOnly: true, Result: "search results",
	})
	if out.blocked || out.errMsg != "" || out.output != "search results" {
		t.Fatalf("search outcome = %+v, want unblocked with result", out)
	}
}

// TestReadOnlyExecutionBlocksMalformedSearch covers the fail-closed side of the
// fix: a search resolution that drops any safety guarantee (execution not
// skipped, classified as a writer, or carrying a target tool) must still be
// rejected as a malformed dynamic inspection.
func TestReadOnlyExecutionBlocksMalformedSearch(t *testing.T) {
	target := readOnlyBoundaryTarget{name: "mcp__test__search", readOnly: true}
	for _, tc := range []struct {
		name     string
		resolved tool.ResolvedCall
	}{
		{name: "not skip execute", resolved: tool.ResolvedCall{ProxyAction: "search", SkipExecute: false, ReadOnly: true, Result: "search results"}},
		{name: "not read only", resolved: tool.ResolvedCall{ProxyAction: "search", SkipExecute: true, ReadOnly: false, Result: "search results"}},
		{name: "carries target", resolved: tool.ResolvedCall{ProxyAction: "search", SkipExecute: true, ReadOnly: true, Target: target, Result: "search results"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := executeReadOnlyBoundaryCall(t, tc.resolved)
			if !out.blocked || !strings.Contains(out.output, "malformed dynamic inspection") {
				t.Fatalf("malformed search outcome = %+v, want block with malformed inspection", out)
			}
		})
	}
}
