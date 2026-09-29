package boot

import (
	"context"
	"errors"

	"reasonix/internal/agent"
	"reasonix/internal/event"
	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

func preserveSubagentFailure(run *agent.SubagentRun, store *agent.SubagentStore, cause error) (string, error) {
	subErr := agent.NewSubagentRunError(run, cause)
	var saveErr error
	if store != nil {
		saveErr = store.SaveOutcome(run, subErr.Outcome)
	}
	return subErr.SubagentOutput(), errors.Join(subErr, saveErr)
}

// runReadOnlySkillSession runs a read-only skill sub-agent. It persists no
// transcript, but when a store and parent session are available it records a
// status-only sidecar so the desktop status strip can name the run while it
// works and drop it when it ends — the same visibility writer skills get.
func runReadOnlySkillSession(ctx context.Context, prov provider.Provider, reg *tool.Registry, prompt string, opts agent.Options, sink event.Sink, systemPrompt string,
	runner func(context.Context, provider.Provider, *tool.Registry, *agent.Session, string, agent.Options, event.Sink) (string, error),
) (string, error) {
	run := agent.EphemeralSubagentRun(systemPrompt)
	answer, err := runner(ctx, prov, reg, run.Session, prompt, opts, sink)
	if err != nil {
		return preserveSubagentFailure(run, nil, err)
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
