package boot

import (
	"context"
	"errors"

	"reasonix/internal/agent"
	"reasonix/internal/event"
)

func preserveSubagentFailure(run *agent.SubagentRun, store *agent.SubagentStore, cause error) (string, error) {
	subErr := agent.NewSubagentRunError(run, cause)
	var saveErr error
	if store != nil {
		saveErr = store.SaveOutcome(run, subErr.Outcome)
	}
	return subErr.SubagentOutput(), errors.Join(subErr, saveErr)
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
