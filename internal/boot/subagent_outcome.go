package boot

import (
	"context"
	"errors"
	"strings"

	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
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

func preserveSubagentFailure(run *agent.SubagentRun, store *agent.SubagentStore, cause error) (string, error) {
	subErr := agent.NewSubagentRunError(run, cause)
	var saveErr error
	if store != nil {
		saveErr = store.SaveOutcome(run, subErr.Outcome)
	}
	return subErr.SubagentOutput(), errors.Join(subErr, saveErr)
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

func saveSubagentCompleted(store *agent.SubagentStore, run *agent.SubagentRun) error {
	if store == nil {
		return nil
	}
	return store.SaveCompleted(run)
}

func announceSkillSubagentStart(sink event.Sink, parentID, skillName, model, effort string, run *agent.SubagentRun, continued bool) {
	phase := "child_created"
	if continued {
		phase = "child_resume"
	}
	agent.EmitSubagentLifecycle(sink, phase, parentID, skillName, model, effort, run, nil)
}

func finishSkillSubagentFailure(ctx context.Context, taskTool *agent.TaskTool, store *agent.SubagentStore, sink event.Sink, parentID, skillName, model, effort, taskText string, run *agent.SubagentRun, cause error) (string, error) {
	result, runErr := preserveSubagentFailure(run, store, cause)
	if taskTool != nil {
		result, runErr = taskTool.ResolveAmbiguousSubagentFailure(ctx, run, taskText, model, sink, cause)
	}
	phase, outcome := agent.TerminalSubagentLifecycle(runErr)
	agent.EmitSubagentLifecycle(sink, phase, parentID, skillName, model, effort, run, outcome)
	return result, runErr
}
