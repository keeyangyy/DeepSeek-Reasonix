package recovery

import (
	"encoding/json"
	"strings"

	"reasonix/internal/evidence"
	"reasonix/internal/shellsafe"
)

// QualifyingFailure reports whether an observation should arm the checkpoint.
// User rejections, host policy blocks, cancels, provider errors, and empty
// search results never qualify.
func QualifyingFailure(obs Observation) bool {
	if obs.Success || obs.Blocked || obs.UserRejected || obs.ProviderError || obs.Cancelled || obs.EmptySearch {
		return false
	}
	// Mutating tool failure always qualifies.
	if obs.Mutates {
		return true
	}
	// Host-recognized verification command non-zero exit.
	if obs.Verification {
		return true
	}
	// File/shell/MCP tools that can change state but reported non-readonly.
	if !obs.ReadOnly && strings.TrimSpace(obs.Tool) != "" {
		return true
	}
	return false
}

// ClassifyFailure identifies the owning recovery policy without treating an
// execution reliability problem as a permission or user-decision boundary.
// The classifier is deliberately narrow: permission/sandbox/user blocks are
// filtered by QualifyingFailure before this is called.
func ClassifyFailure(obs Observation) FailureClass {
	if transientFailureText(obs.ErrSummary) || transientFailureText(obs.Output) {
		return FailureClassTransient
	}
	if obs.Verification {
		return FailureClassVerification
	}
	if obs.Mutates {
		return FailureClassMutation
	}
	return FailureClassExecution
}

func transientFailureText(text string) bool {
	text = strings.ToLower(strings.TrimSpace(text))
	if text == "" {
		return false
	}
	for _, marker := range []string{
		"command timed out",
		"timed out after",
		"timed out (>",
		"context deadline exceeded",
		"deadline exceeded",
		"execution timeout",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// IsVerificationCall reports whether the host recognizes the call as a
// verification command (test/lint/build/typecheck/compile).
func IsVerificationCall(tool string, args json.RawMessage, readOnly bool) bool {
	tool = strings.TrimSpace(tool)
	if tool == "bash" {
		return evidence.IsVerificationCommand(commandFromArgs(args))
	}
	// Project-check style tools are verification even when not bash.
	switch tool {
	case "complete_step":
		return false
	}
	_ = readOnly
	return false
}

// IsSafeVerificationRetry reports whether proposal is a first safe retry of the
// same host-proven verification command that failed.
// Callers must also consult the runtime safe-retry budget (safeRetryUsed /
// SafeRetryLeft); a spent budget never qualifies.
func IsSafeVerificationRetry(failure *FailureEvent, proposal Proposal) bool {
	if failure == nil || !failure.Verification {
		return false
	}
	if failure.SafeRetryLeft <= 0 {
		// evidenceCopy sets SafeRetryLeft from runtime truth; 0 means spent.
		return false
	}
	if !proposal.Verification || proposal.HighRisk || proposal.ExpandedScope || proposal.StrategyChanged {
		return false
	}
	if strings.TrimSpace(proposal.Tool) != strings.TrimSpace(failure.Tool) {
		return false
	}
	// Same normalized command / subject for verification retries.
	if normalizeCommand(proposal.Subject) != "" && normalizeCommand(failure.Subject) != "" {
		return normalizeCommand(proposal.Subject) == normalizeCommand(failure.Subject)
	}
	return CallFingerprint(proposal.Tool, proposal.Subject, "", proposal.Args) ==
		CallFingerprint(failure.Tool, failure.Subject, "", failure.Args)
}

// IsHighRiskMutation preserves the legacy execution-risk classifier for event
// compatibility and focused policy tests. Auto no longer turns this result into
// a human confirmation; permission, sandbox, and tool policy own that boundary.
func IsHighRiskMutation(proposal Proposal) bool {
	return riskBoundaryForProposal(proposal).highRisk
}

// TaskGrantKey returns the legacy semantic key used by persisted recovery cards.
// New Auto decisions do not create execution-risk grants. Keys remain narrower
// than a command name but broader than raw command bytes:
// for example, ordinary pushes to the same Git remote destination share a key,
// while a different ref, force push, or arbitrary HTTP/API mutation never does.
func TaskGrantKey(proposal Proposal) string {
	return riskBoundaryForProposal(proposal).taskGrantKey
}

type riskBoundary struct {
	highRisk         bool
	taskGrantKey     string
	taskGrantDisplay string
}

func riskBoundaryForProposal(proposal Proposal) riskBoundary {
	if proposal.HighRisk {
		// Caller-supplied risk has no host-proven semantic scope, so it is never
		// eligible for a reusable task grant.
		return riskBoundary{highRisk: true}
	}
	tool := strings.TrimSpace(proposal.Tool)
	if strings.HasPrefix(tool, "mcp__") || strings.Contains(tool, "mcp") {
		// MCP already has a richer policy/destructive-hint gate. Duplicating that
		// prompt here would create two human decisions for one call.
		return riskBoundary{}
	}
	if tool == "bash" {
		cmd := commandFromArgs(proposal.Args)
		// Host-recognized test/build commands may create project-local artifacts,
		// but are already bounded by the verification classifier. Deterministic
		// destructive forms still trip commandFieldsHighRisk below.
		return bashRiskBoundary(cmd, proposal.Mutates && !proposal.Verification)
	}
	// Workspace file tools remain on Auto's fast path, including dependency,
	// configuration, and workflow files. Sandbox and explicit approval policy
	// still own writes outside the workspace; this layer only adds hard-boundary
	// confirmation for commands the host can classify deterministically.
	return riskBoundary{}
}

// ClassifyEmptySearch reports whether a successful read-only search produced
// no matches. Callers set Observation.EmptySearch from this.
func ClassifyEmptySearch(tool string, success bool, readOnly bool, output string) bool {
	if !success || !readOnly {
		return false
	}
	switch strings.TrimSpace(tool) {
	case "grep", "glob", "ls", "code_index", "codeindex":
		// fall through
	default:
		return false
	}
	out := strings.TrimSpace(output)
	if out == "" {
		return true
	}
	lower := strings.ToLower(out)
	for _, marker := range []string{
		"no matches",
		"no files found",
		"0 matches",
		"not found",
		"no results",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// IsDiagnosticSuccess reports a successful read-only diagnostic that must not
// clear the active failure event (ls/rg/grep/read_file, etc.).
func IsDiagnosticSuccess(obs Observation) bool {
	if !obs.Success || obs.Mutates || obs.Verification {
		return false
	}
	switch strings.TrimSpace(obs.Tool) {
	case "bash":
		cmd := commandFromArgs(obs.Args)
		if shellsafe.ClassifyBash(cmd).AnyMutation() {
			return false
		}
		return true
	case "read_file", "grep", "glob", "ls", "code_index", "codeindex":
		return obs.ReadOnly
	default:
		return false
	}
}
