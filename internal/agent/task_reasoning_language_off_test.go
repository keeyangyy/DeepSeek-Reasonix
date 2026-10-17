package agent

import (
	"strings"
	"testing"

	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

func TestTaskToolInheritsReasoningLanguageOff(t *testing.T) {
	sub := &mockProvider{name: "sub", chunks: []provider.Chunk{
		{Type: provider.ChunkText, Text: "done"},
		{Type: provider.ChunkDone},
	}}
	task := newTestTaskTool(t, sub, tool.NewRegistry(), "sys", "", "", nil)

	// A Chinese prompt would be wrapped under auto; off must reach the child
	// untouched through the same context path.
	ctx := WithReasoningLanguagePreference(testTaskContext(), "off")
	if _, err := task.Execute(ctx, []byte(`{"prompt":"检查鉴权逻辑"}`)); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	got := lastUser(sub.lastReq)
	if strings.Contains(got, "<reasoning-language>") {
		t.Fatalf("sub-agent user = %q, want no reasoning-language block under off", got)
	}
	if !strings.Contains(got, "检查鉴权逻辑") {
		t.Fatalf("sub-agent user = %q, want the original prompt", got)
	}
}
