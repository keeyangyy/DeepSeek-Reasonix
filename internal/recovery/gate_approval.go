package recovery

import (
	"fmt"
	"strings"
)

// HasApproval reports whether a live Auto decision waiter is parked under id.
// Unlike Snapshot, this includes normal-execution plan transitions that have a
// waiter but no armed failure/taskRuntime yet. Legacy Approve paths must use
// this (or Resolve) instead of inferring from a persistence snapshot.
func (g *Gate) HasApproval(id string) bool {
	if g == nil {
		return false
	}
	id = strings.TrimSpace(id)
	if id == "" || strings.HasPrefix(id, "pending:") {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.waiters[id]; ok {
		return true
	}
	_, ok := g.taskOf[id]
	return ok
}

// BindApprovalID associates a prompt id with the task waiting on it so
// Resolve can find the waiter after EmitPrompt returns. If a provisional
// waiter is parked under pending:<taskID>, it is re-keyed to approvalID.
func (g *Gate) BindApprovalID(taskID, approvalID string) {
	if g == nil {
		return
	}
	taskID = normalizeTaskID(taskID)
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	provisional := "pending:" + taskID
	if ch := g.waiters[provisional]; ch != nil {
		delete(g.waiters, provisional)
		delete(g.taskOf, provisional)
		g.waiters[approvalID] = ch
	}
	if pending, ok := g.pending[provisional]; ok {
		delete(g.pending, provisional)
		g.pending[approvalID] = pending
	}
	g.taskOf[approvalID] = taskID
	g.awaiting[taskID] = struct{}{}
}

// UnbindApprovalID rolls back a prompt that could not be durably published.
// The provisional waiter is cleaned by the caller's EmitPrompt error path.
func (g *Gate) UnbindApprovalID(taskID, approvalID string) {
	if g == nil {
		return
	}
	taskID = normalizeTaskID(taskID)
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return
	}
	g.mu.Lock()
	delete(g.waiters, approvalID)
	delete(g.taskOf, approvalID)
	delete(g.pending, approvalID)
	delete(g.resolving, approvalID)
	delete(g.awaiting, taskID)
	g.mu.Unlock()
}

// Resolve applies a user decision to a pending Auto Guard approval.
// action is continue|continue_task|revise. For revise, feedback is returned through the
// blocked tool result and the current mutation is refused in the same operation.
func (g *Gate) Resolve(id string, action Action, feedback string) error {
	return g.ResolveAfter(id, action, feedback, nil)
}

// ResolveAfter validates a pending decision, runs before while the decision is
// still reserved, and only then releases the waiter. Controllers use it to
// durably record PromptAnswered before an agent or tool can resume.
func (g *Gate) ResolveAfter(id string, action Action, feedback string, before func() error) error {
	if g == nil {
		return fmt.Errorf("recovery gate is nil")
	}
	id = strings.TrimSpace(id)
	g.mu.Lock()
	ch := g.waiters[id]
	taskID := g.taskOf[id]
	pending := g.pending[id]
	if taskID == "" {
		g.mu.Unlock()
		return fmt.Errorf("unknown recovery approval %q", id)
	}
	if g.resolving[id] != 0 {
		g.mu.Unlock()
		return fmt.Errorf("recovery approval %q is already being resolved", id)
	}
	rotateEpisode := false
	switch action {
	case ActionContinue, ActionContinueTask:
		if action == ActionContinueTask {
			if pending.TaskGrantKey == "" {
				g.mu.Unlock()
				return fmt.Errorf("recovery approval %q cannot grant similar actions", id)
			}
		}
	case ActionRevise:
		rotateEpisode = true
		if strings.TrimSpace(feedback) == "" {
			feedback = DefaultReviseFeedback
		}
	default:
		g.mu.Unlock()
		return fmt.Errorf("unknown recovery action %q", action)
	}
	g.resolveSeq++
	if g.resolveSeq == 0 {
		g.resolveSeq++
	}
	token := g.resolveSeq
	g.resolving[id] = token
	g.mu.Unlock()

	if before != nil {
		if err := before(); err != nil {
			g.mu.Lock()
			if g.resolving[id] == token {
				delete(g.resolving, id)
			}
			g.mu.Unlock()
			return err
		}
	}

	g.mu.Lock()
	if g.resolving[id] != token || g.taskOf[id] != taskID || g.waiters[id] != ch {
		if g.resolving[id] == token {
			delete(g.resolving, id)
		}
		g.mu.Unlock()
		return fmt.Errorf("recovery approval %q is no longer pending", id)
	}
	st := g.tasks[taskID]
	switch action {
	case ActionContinue, ActionContinueTask:
		if action == ActionContinueTask {
			if st == nil {
				st = &taskRuntime{episodeID: g.episodeID}
				g.tasks[taskID] = st
			}
			st.useTaskGrantScope(pending.TaskGrantTaskScope)
			st.addTaskGrant(pending.TaskGrantKey)
			g.metrics.TaskGrantContinues++
		}
		// Human continue does not reset Episode reviewer rejects; only real
		// mutation/verification progress, a new Episode, or revise does.
		g.metrics.HumanContinues++
	case ActionRevise:
		// Revise rejects the pending action and starts a fresh Recovery Episode
		// so alternative approaches get a clean budget.
		g.metrics.HumanRevises++
	}
	delete(g.waiters, id)
	delete(g.taskOf, id)
	delete(g.pending, id)
	delete(g.resolving, id)
	delete(g.awaiting, taskID)
	if !rotateEpisode {
		if st == nil || (st.empty() && !st.hasTaskGrants()) {
			delete(g.tasks, taskID)
		}
	}
	g.mu.Unlock()

	if ch != nil {
		select {
		case ch <- resolvePayload{action: action, feedback: feedback}:
		default:
		}
	}
	if rotateEpisode {
		// Fresh Episode after "try another approach" so alternatives get a clean
		// budget. BeginEpisode also dismisses any other waiters safely.
		g.BeginEpisode()
	} else {
		g.persist()
	}
	return nil
}
