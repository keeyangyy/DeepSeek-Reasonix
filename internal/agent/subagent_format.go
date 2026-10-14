package agent

import "strings"

func FormatSubagentRunResult(answer string, run *SubagentRun, failed bool) string {
	answer = GuardSubagentHostDecisionText(answer)
	if run == nil || run.Ref == "" {
		return answer
	}
	// A status-only run keeps its "no readable transcript" promise: it recorded
	// status for the strip, but there is no transcript to reference, so the
	// answer carries no resume handle.
	if run.StatusOnly {
		return answer
	}
	if failed {
		out := FormatSubagentOutcome(SubagentOutcome{Ref: run.Ref, Status: SubagentOutcomeFailed, FinalAnswer: answer})
		return strings.Replace(out, "Subagent reference: "+run.Ref, "Subagent reference (failed): "+run.Ref, 1)
	}
	guidance := FormatSubagentReference(run)
	if _, rest, ok := strings.Cut(guidance, "\n"); ok {
		guidance = rest
	} else {
		guidance = ""
	}
	out := FormatSubagentOutcome(SubagentOutcome{Ref: run.Ref, Status: SubagentOutcomeCompleted})
	if guidance != "" {
		out += "\n\n" + guidance
	}
	if answer != "" {
		out += "\n\nFinal answer:\n" + answer
	}
	return out
}
