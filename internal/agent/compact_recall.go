package agent

import (
	"context"
	"fmt"
	"strings"

	"reasonix/internal/provider"
	"reasonix/internal/tool"
)

// A fold's index gives an address; recall is what reads it. The budget is per
// generation so the fold that freed the window cannot be undone by the turns
// after it: a recall loop runs out of budget instead of running forever.
const recallBudgetRatio = 0.10

const minRecallBudgetTokens = 2000

// recallBudget is one generation's ceiling on pulling folded content back.
func (a *Agent) recallBudget() int {
	window := a.effectiveContextWindow()
	if window <= 0 {
		return minRecallBudgetTokens
	}
	return max(minRecallBudgetTokens, int(float64(window)*recallBudgetRatio))
}

// renderTranscriptVerbatim flattens recalled messages without the bounds the
// summary transcript applies: recall exists to return the original bytes.
func renderTranscriptVerbatim(msgs []provider.Message) string {
	var b strings.Builder
	for _, m := range msgs {
		switch m.Role {
		case provider.RoleUser:
			fmt.Fprintf(&b, "[user]\n%s\n\n", m.Content)
		case provider.RoleAssistant:
			if m.Content != "" {
				fmt.Fprintf(&b, "[assistant]\n%s\n", m.Content)
			}
			for _, tc := range m.ToolCalls {
				fmt.Fprintf(&b, "[assistant calls %s] %s\n", tc.Name, tc.Arguments)
			}
			b.WriteString("\n")
		case provider.RoleTool:
			body := m.Content
			if m.RawContent != "" {
				body = m.RawContent
			}
			fmt.Fprintf(&b, "[tool %s result]\n%s\n\n", m.Name, body)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// RecallContext reads folded canonical positions, or searches for them. What
// comes back re-enters context as an ordinary tool result, never a projection.
// Both operations spend one generation budget: two would let a search refill
// what a read was refused.
func (a *Agent) RecallContext(_ context.Context, req tool.RecallRequest) (tool.RecallResult, error) {
	if !a.foldIndexEnabled() {
		return tool.RecallResult{}, fmt.Errorf("recall: the folded work index is disabled in this session's settings (agent.fold_index=false); positions from older summaries may still name folded content")
	}
	query := strings.TrimSpace(req.Query)
	switch {
	case query != "" && len(req.Positions) > 0:
		return tool.RecallResult{}, fmt.Errorf("recall: give positions to read or a query to search, not both")
	case query == "" && len(req.Positions) == 0:
		return tool.RecallResult{}, fmt.Errorf("recall: no positions given")
	}
	canonical, _ := a.sess.conversation.snapshotMessagesVersion()

	a.sess.compactionMu.Lock()
	defer a.sess.compactionMu.Unlock()
	state := &a.sess.compactionState
	covered := min(state.Projection.CoveredCount, len(canonical))
	if covered <= 0 {
		return tool.RecallResult{}, fmt.Errorf("recall: nothing has been folded in this session yet, so every position is still in your context")
	}
	if state.Recall.Generation != state.Generation {
		state.Recall = RecallLedger{Generation: state.Generation}
	}
	budget := a.recallBudget()
	left := budget - state.Recall.SpentTokens
	if query != "" {
		return a.searchRecallLocked(canonical[:covered], query, req, budget, left)
	}

	var body strings.Builder
	var recalled, missing []int
	for _, pos := range req.Positions {
		if pos < 0 || pos >= len(canonical) {
			missing = append(missing, pos)
			continue
		}
		if pos >= covered {
			return tool.RecallResult{}, fmt.Errorf("recall: #%d is not folded — it is still in your context, so read it there", pos)
		}
		rendered := renderTranscriptVerbatim(a.recallSpan(canonical, pos))
		if strings.TrimSpace(rendered) == "" {
			missing = append(missing, pos)
			continue
		}
		fmt.Fprintf(&body, "#%d\n%s\n", pos, strings.TrimRight(rendered, "\n"))
		recalled = append(recalled, pos)
	}
	if len(recalled) == 0 {
		return tool.RecallResult{BudgetLeft: left, Missing: missing},
			fmt.Errorf("recall: %s named nothing the transcript still holds", positionsText(missing))
	}
	// Refused whole rather than truncated: a half-recalled span reads as the
	// whole of what was there, which is the failure recall exists to prevent.
	cost := estimateTextTokens(body.String())
	if cost > left {
		return tool.RecallResult{BudgetLeft: left},
			fmt.Errorf("recall: %d tokens exceeds the %d left in this generation's recall budget — ask for fewer positions", cost, left)
	}
	state.Recall.SpentTokens += cost
	return tool.RecallResult{
		Text:       strings.TrimRight(body.String(), "\n"),
		Recalled:   recalled,
		Missing:    missing,
		Tokens:     cost,
		BudgetLeft: budget - state.Recall.SpentTokens,
	}, nil
}

// recallSpan returns the message at pos plus the tool results that answer it.
// An index line addresses the call, and a call without its result is the half
// that says least.
func (a *Agent) recallSpan(canonical []provider.Message, pos int) []provider.Message {
	span := []provider.Message{canonical[pos]}
	wanted := map[string]bool{}
	for _, tc := range canonical[pos].ToolCalls {
		wanted[tc.ID] = true
	}
	for i := pos + 1; i < len(canonical) && len(wanted) > 0; i++ {
		m := canonical[i]
		if m.Role != provider.RoleTool {
			break
		}
		if wanted[m.ToolCallID] {
			span = append(span, m)
			delete(wanted, m.ToolCallID)
		}
	}
	return span
}

// ContextBudget reports the distance to the compaction trigger: the fold is
// the event the model can still act ahead of, and it fires well before the
// window is physically full.
func (a *Agent) ContextBudget() tool.ContextBudget {
	window := a.effectiveContextWindow()
	if window <= 0 {
		return tool.ContextBudget{Status: "unmeasured", Reason: "provider context window unknown"}
	}
	compactAt := a.compactTrigger()
	used := a.estimatedVisibleRequestTokens(a.modelVisibleMessages())
	return tool.ContextBudget{
		Status:          "ok",
		TokensRemaining: max(0, compactAt-used),
		TokensUsed:      used,
		CompactAt:       compactAt,
		Window:          window,
	}
}

func positionsText(positions []int) string {
	if len(positions) == 0 {
		return "the request"
	}
	parts := make([]string, len(positions))
	for i, p := range positions {
		parts[i] = fmt.Sprintf("#%d", p)
	}
	return strings.Join(parts, ", ")
}

var _ tool.ContextRecaller = (*Agent)(nil)
var _ tool.ContextBudgetReporter = (*Agent)(nil)
