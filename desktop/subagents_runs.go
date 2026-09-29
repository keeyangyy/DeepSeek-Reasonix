package main

import (
	"strings"

	"reasonix/internal/agent"
)

// SubagentRunView is the desktop-bound projection of one persisted sub-agent
// run. The status strip renders exactly one line per entry, so the wire payload
// carries only what that line needs: the precomputed label, the status that
// decides whether the line exists at all, and timestamps for the elapsed time.
type SubagentRunView struct {
	Ref string `json:"ref"`
	// ParentToolCallID is "<toolCallID>/<index>" for a call fanned out by
	// fleet/parallel_tasks; plain "<toolCallID>" for a direct dispatch. The
	// prefix identifies the dispatching call in the parent transcript.
	ParentToolCallID string `json:"parentToolCallId,omitempty"`
	// Label is "<name>: <content>", computed and clipped by the backend at
	// dispatch. Every surface reads this one string, so a run's label never
	// changes between live, session-switched, and settled views.
	Label     string `json:"label"`
	Status    string `json:"status"`
	Outcome   string `json:"outcome,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// ListSubagentsForTab reports the sub-agent runs persisted for the tab's
// current session. The parent transcript records only the dispatching call and
// keeps no parent/child link, so which runs exist and whether each is still
// running live in the run's own meta sidecar; the status strip reads them from
// here, which is what makes a session switch and a background run show the same
// list as the live view.
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
			Label:            meta.Label,
			Status:           string(meta.Status),
			Outcome:          meta.Outcome,
			ErrorCode:        meta.ErrorCode,
			CreatedAt:        meta.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
			UpdatedAt:        meta.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	return out
}
