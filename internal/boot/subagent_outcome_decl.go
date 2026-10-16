package boot

import (
	"context"
	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
	"strings"
)

// readOnlyStatusSpec describes a read-only run for its status sidecar only.
func readOnlyStatusSpec(ctx context.Context, name, task, root, systemPrompt, model, effort string) agent.SubagentSpec {
	callID, _, _, _ := agent.CallContext(ctx)
	return agent.SubagentSpec{
		Kind:             "skill",
		Name:             name,
		Label:            agent.SubagentDispatchLabel(name, "", task),
		WorkspaceRoot:    root,
		ParentSession:    agent.ParentSession(ctx),
		ParentToolCallID: callID,
		SystemPrompt:     systemPrompt,
		Model:            model,
		Effort:           effort,
	}
}

// readOnlyStatusRun prepares the status sidecar that makes a read-only run
// visible in the desktop status strip, writing no transcript body: the run
// keeps its "no readable transcript" promise and still shows as running work.
// A missing store or owning session degrades to a purely ephemeral run.
func readOnlyStatusRun(store *agent.SubagentStore, spec agent.SubagentSpec) *agent.SubagentRun {
	if store == nil || strings.TrimSpace(spec.ParentSession) == "" {
		return agent.EphemeralSubagentRun(spec.SystemPrompt)
	}
	run, err := store.PrepareFresh(spec)
	if err != nil {
		return agent.EphemeralSubagentRun(spec.SystemPrompt)
	}
	agent.MarkDispatchRunning(store, run, true)
	return run
}

// runReadOnlySkillSession runs a read-only skill sub-agent. It persists no
// transcript, but records a status-only sidecar so the desktop status strip
// names the run while it works and drops it when it ends — the same visibility
// a writer skill gets, without a readable transcript left behind.
func runReadOnlySkillSession(ctx context.Context, prov provider.Provider, reg *tool.Registry, prompt string, opts agent.Options, sink event.Sink,
	runner func(context.Context, provider.Provider, *tool.Registry, *agent.Session, string, agent.Options, event.Sink) (string, error),
	store *agent.SubagentStore, spec agent.SubagentSpec,
) (string, error) {
	run := readOnlyStatusRun(store, spec)
	defer run.Release()
	answer, err := runner(ctx, prov, reg, run.Session, prompt, opts, sink)
	if err != nil {
		return preserveSubagentFailure(run, store, err)
	}
	if err := saveSubagentCompleted(store, run); err != nil {
		return preserveSubagentFailure(run, store, err)
	}
	return answer, nil
}
