package main

import (
	"strings"

	"reasonix/internal/agent"
)

// SubagentRunView is the desktop-bound projection of one persisted sub-agent
// run. The full meta sidecar carries authoring detail the panel never shows;
// this keeps the wire payload to what the UI renders plus the parent link that
// rebuilds the nesting after a session switch.
type SubagentRunView struct {
	Ref string `json:"ref"`
	// ParentToolCallID is "<toolCallID>/<childIndex>" for a call fanned out by
	// fleet/parallel_tasks; plain "<toolCallID>" for a direct task. The prefix
	// identifies the dispatching call in the parent transcript.
	ParentToolCallID string `json:"parentToolCallId,omitempty"`
	Kind             string `json:"kind"`
	Name             string `json:"name"`
	Status           string `json:"status"`
	Outcome          string `json:"outcome,omitempty"`
	Retryable        bool   `json:"retryable,omitempty"`
	ErrorCode        string `json:"errorCode,omitempty"`
	Model            string `json:"model,omitempty"`
	Effort           string `json:"effort,omitempty"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

// ListSubagentsForTab reports the sub-agent runs persisted for the tab's
// current session. The parent transcript records only the dispatching call
// (and keeps no parent/child link), so the nesting and the settled outcome of
// each sub-agent live in the run's own meta sidecar; this binding is how the
// sub-agent panel recovers them after a session switch.
func (a *App) ListSubagentsForTab(tabID string) []SubagentRunView {
	out := []SubagentRunView{}
	target, err := a.taskMonitorTargetForTab(tabID)
	if err != nil {
		return out
	}
	sessionPath := strings.TrimSpace(target.sessionPath)
	if sessionPath == "" {
		return out
	}
	artifacts, err := agent.ListSubagentsByParent(target.sessionDir, agent.BranchID(sessionPath))
	if err != nil {
		return out
	}
	for _, artifact := range artifacts {
		meta := artifact.Meta
		out = append(out, SubagentRunView{
			Ref:              artifact.Ref,
			ParentToolCallID: meta.ParentToolCallID,
			Kind:             meta.Kind,
			Name:             meta.Name,
			Status:           string(meta.Status),
			Outcome:          meta.Outcome,
			Retryable:        meta.Retryable,
			ErrorCode:        meta.ErrorCode,
			Model:            meta.Model,
			Effort:           meta.Effort,
			CreatedAt:        meta.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
			UpdatedAt:        meta.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	return out
}
