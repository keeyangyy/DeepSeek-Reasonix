package recovery

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"reasonix/internal/agent"
)

// ObserveResult implements agent.RecoveryGate. It returns one-shot guidance
// for the caller to enqueue on the exact Agent.Run that observed the failure.
func (g *Gate) ObserveResult(_ context.Context, obs Observation) string {
	if g == nil || !g.activeMode() {
		return ""
	}
	taskID := normalizeTaskID(obs.TaskID)

	g.mu.Lock()
	defer g.mu.Unlock()

	// Stale observations from a previous generation (mode switch / episode
	// rotate mid-flight) are ignored so they cannot re-arm old locks.
	if obs.Generation != 0 && obs.Generation != g.generation {
		g.metrics.StaleObservationsIgnored++
		return ""
	}

	st := g.ensureTaskLocked(taskID)

	// Successful host-recognized verification clears Episode no-progress budgets.
	if obs.Success && obs.Verification {
		g.clearNoProgressLocked(taskID, st)
		g.persistUnlocked()
		return ""
	}
	// Any successful mutation ends the current no-progress budget.
	if obs.Success && obs.Mutates {
		g.clearNoProgressLocked(taskID, st)
		g.persistUnlocked()
		return ""
	}
	// Diagnostic read successes do not clear failure state. Preserve a bounded
	// evidence excerpt for the isolated reviewer; otherwise it sees the failure
	// and proposed diff but none of the investigation that connected them.
	if obs.Success {
		if st.lastFailure != nil && IsDiagnosticSuccess(obs) {
			if appendDiagnosisNote(st.lastFailure, diagnosticObservationNote(obs)) {
				g.persistUnlocked()
			}
		}
		return ""
	}
	if !QualifyingFailure(obs) {
		return ""
	}

	fp := observationFingerprint(obs)
	st.ensureMaps()
	st.episodeID = g.episodeID
	if st.operationFailures[fp] < 255 {
		st.operationFailures[fp]++
	}
	// Episode totals accumulate across every TaskID (root + sub-agents).
	if g.episode.totalFailures < 255 {
		g.episode.totalFailures++
	}
	if st.operationFailures[fp] >= MaxOperationFailures {
		st.markOperationStopped(fp)
		g.metrics.OperationStops++
	}
	if g.episode.totalFailures >= MaxEpisodeFailures {
		g.episode.stopped = true
		g.episode.stopReason = StopReasonEpisodeFailures
		g.metrics.EpisodeFailureStops++
	}

	st.lastFailure = &activeFailure{
		evidence: FailureEvent{
			Class:         ClassifyFailure(obs),
			Tool:          obs.Tool,
			ArgsSummary:   ArgsSummary(obs.Args, 200),
			Subject:       obs.Subject,
			ErrSummary:    obs.ErrSummary,
			OutputExcerpt: clip(obs.Output, 1500),
			SourceAgent:   obs.AgentID,
			TaskID:        taskID,
			TaskScopeID:   persistentRecoveryScope(obs.TaskScopeID),
			ReadOnly:      obs.ReadOnly,
			Verification:  obs.Verification,
			Mutates:       obs.Mutates,
			CreatedAt:     g.opts.Now(),
			Args:          append(json.RawMessage(nil), obs.Args...),
			Fingerprint:   fp,
		},
		safeRetryUsed: false,
	}
	// Keep diagnosis notes if same fingerprint; otherwise start fresh list.
	g.metrics.FailureEvents++
	guidance := g.recoveryGuidanceLocked(st)
	g.persistUnlocked()
	return guidance
}

// BeforeMutation implements agent.RecoveryGate.
func (g *Gate) BeforeMutation(ctx context.Context, proposal Proposal) (Decision, error) {
	if g == nil {
		return Decision{Allow: true}, nil
	}

	// Host-proven read-only diagnostics always continue, including after the
	// Episode execution budget is exhausted. Decide also encodes the non-Auto
	// bypass so Ask and YOLO keep their existing semantics.
	facts, failure, diagNotes, taskID, fp, gen := g.classify(proposal)
	route := Decide(facts)

	// Escalation: re-proposing an already-stopped operation burns the
	// stopped-op retry budget and may stop the whole turn.
	if facts.AutoMode && facts.OperationAlreadyStopped && facts.SameFailedOperation {
		dec, escalated := g.noteStoppedOpRetry(taskID, fp, gen, proposal)
		if escalated {
			return dec, nil
		}
		// Still under retry budget: fall through to RouteStop for this op.
		route = DecisionResult{Route: RouteStop, StopReason: StopReasonOperationFailures}
	}

	// Episode total failure hard stop before reviewer work.
	if facts.AutoMode && facts.EpisodeFailureCount >= MaxEpisodeFailures && (facts.Mutates || facts.Verification) {
		return g.stopTurnDecision(taskID, gen, StopReasonEpisodeFailures, proposal), nil
	}

	switch route.Route {
	case RouteBypass, RouteAllow:
		if route.ConsumeSafeRetry {
			g.mu.Lock()
			if st := g.tasks[taskID]; st != nil && st.lastFailure != nil && !st.lastFailure.safeRetryUsed {
				st.lastFailure.safeRetryUsed = true
				g.metrics.RuleContinues++
			}
			g.mu.Unlock()
			g.persist()
		}
		return Decision{Allow: true, Generation: gen}, nil
	case RouteReview:
		return g.reviewOrEscalate(ctx, taskID, fp, gen, proposal, failure, diagNotes)
	case RouteStop:
		return Decision{
			Allow:      false,
			Blocked:    true,
			Message:    repeatedFailureStopMessage(int(facts.FailureCount), proposal),
			Generation: gen,
			StopReason: string(StopReasonOperationFailures),
		}, nil
	case RouteStopTurn:
		return g.stopTurnDecision(taskID, gen, route.StopReason, proposal), nil
	default:
		return Decision{Allow: true, Generation: gen}, nil
	}
}
func (g *Gate) noteStoppedOpRetry(taskID, _ string, gen uint64, proposal Proposal) (Decision, bool) {
	g.mu.Lock()
	_ = g.ensureTaskLocked(taskID)
	if g.episode.stoppedOpRetries < 255 {
		g.episode.stoppedOpRetries++
	}
	retries := g.episode.stoppedOpRetries
	if retries >= MaxStoppedOperationRetries {
		g.episode.stopped = true
		if g.episode.stopReason == StopReasonNone {
			g.episode.stopReason = StopReasonStoppedOpRetries
		}
		g.metrics.StoppedOpRetryStops++
		g.mu.Unlock()
		g.persist()
		return g.stopTurnDecision(taskID, gen, StopReasonStoppedOpRetries, proposal), true
	}
	g.mu.Unlock()
	g.persist()
	return Decision{}, false
}

func (g *Gate) stopTurnDecision(taskID string, gen uint64, reason StopReason, proposal Proposal) Decision {
	g.mu.Lock()
	_ = g.ensureTaskLocked(taskID)
	g.episode.stopped = true
	if g.episode.stopReason == StopReasonNone {
		g.episode.stopReason = reason
	}
	stopReason := g.episode.stopReason
	g.mu.Unlock()
	g.persist()
	msg := episodeStopMessage(stopReason, proposal)
	return Decision{
		Allow:      false,
		Blocked:    true,
		Message:    msg,
		Generation: gen,
		StopTurn:   true,
		StopReason: string(stopReason),
	}
}

// classify builds pure Facts for Decide. It never calls the model or UI.
func (g *Gate) classify(proposal Proposal) (Facts, *FailureEvent, []string, string, string, uint64) {
	facts := Facts{
		AutoMode:       g.activeMode(),
		ReadOnly:       proposal.ReadOnly,
		Mutates:        proposal.Mutates,
		Verification:   proposal.Verification,
		PlanTransition: proposal.PlanTransition,
	}
	// Deterministic boundary checks run before the failure-recovery path.
	boundary := riskBoundaryForProposal(proposal)
	proposal.HighRisk = boundary.highRisk
	facts.HighRisk = boundary.highRisk

	taskID := normalizeTaskID(proposal.TaskID)
	// Operation failure accounting intentionally excludes Preview. Agent calls
	// always carry a display/approval preview, while completed observations do
	// not; mixing the two shapes would make an exact retry look like an unseen
	// operation and bypass its three-failure stop. Keep the preview-bound
	// fingerprint for one-shot human approval below.
	operationFP := CallFingerprint(proposal.Tool, proposal.Subject, "", proposal.Args)
	approvalFP := CallFingerprint(proposal.Tool, proposal.Subject, proposal.Preview, proposal.Args)

	g.mu.Lock()
	gen := g.generation
	// Leaving Auto does not wait for the next proposal: OnModeChange handles
	// real mode switches. Here we still clear when mode is non-Auto so a
	// bypass path cannot keep armed Auto locks if OnModeChange was skipped.
	st := g.tasks[taskID]
	var failure *FailureEvent
	var diagNotes []string
	stateChanged := false
	// Shared Episode budget applies even when this TaskID has no local state.
	facts.EpisodeStopped = g.episode.stopped
	facts.StopReason = g.episode.stopReason
	facts.EpisodeFailureCount = g.episode.totalFailures
	facts.ReviewRejects = g.episode.reviewRejects
	if st != nil && !facts.AutoMode {
		if !st.empty() || g.episode.totalFailures > 0 || g.episode.reviewRejects > 0 || g.episode.stopped {
			st.clearTaskRecoveryState()
			g.episode.clear()
			stateChanged = true
		}
		if !st.hasTaskGrants() && st.empty() {
			delete(g.tasks, taskID)
			st = nil
		}
	}
	if st != nil {
		// Align task runtime with current Episode without wiping mid-Episode.
		if st.episodeID != "" && st.episodeID != g.episodeID {
			grants := st.taskGrants
			grantScope := st.taskGrantScope
			st.clearTaskRecoveryState()
			st.taskGrants = grants
			st.taskGrantScope = grantScope
			st.episodeID = g.episodeID
			stateChanged = true
		} else if st.episodeID == "" {
			st.episodeID = g.episodeID
		}
		facts.OperationAlreadyStopped = st.isOperationStopped(operationFP)
		facts.FailureCount = st.operationFailureCount(operationFP)
		if st.lastFailure != nil {
			failure = st.evidenceCopy()
			diagNotes = st.diagnosisNotes()
			facts.HasActiveFailure = true
			facts.SameFailedOperation = sameFailedOperation(failure, proposal)
			// When proposing the same op, FailureCount is the map value.
			// When proposing a different op after failures, HasActiveFailure
			// remains true for accounting, but Decide keeps that unrelated
			// operation on the automatic path.
			if facts.SameFailedOperation && facts.FailureCount == 0 {
				// Evidence exists but count was cleared somehow — treat as 1.
				facts.FailureCount = 1
			}
			if IsSafeVerificationRetry(failure, proposal) && st.safeRetryAvailable() {
				facts.SafeRetryAvailable = true
			}
		}
		taskScope := taskGrantScopeKey(proposal)
		st.useTaskGrantScope(taskScope)
		if st.empty() && !st.hasTaskGrants() {
			delete(g.tasks, taskID)
			st = nil
		}
		runtimeGrantKey := taskGrantRuntimeKey(boundary.taskGrantKey, taskScope)
		if facts.HighRisk && runtimeGrantKey != "" && st != nil && st.hasTaskGrant(runtimeGrantKey) {
			facts.HighRisk = false
			g.metrics.TaskGrantUses++
		}
	}
	g.mu.Unlock()
	if stateChanged {
		g.persist()
	}

	if failure != nil {
		if !proposal.ExpandedScope {
			proposal.ExpandedScope = ScopeExpanded(failure, proposal)
		}
		if !proposal.StrategyChanged {
			proposal.StrategyChanged = StrategyChanged(failure, proposal)
		}
		facts.ExpandedScope = proposal.ExpandedScope
		facts.StrategyChanged = proposal.StrategyChanged
		if facts.SafeRetryAvailable && (facts.ExpandedScope || facts.StrategyChanged || facts.HighRisk) {
			facts.SafeRetryAvailable = false
		}
	}
	return facts, failure, diagNotes, taskID, approvalFP, gen
}

func (g *Gate) ensureTaskLocked(taskID string) *taskRuntime {
	st := g.tasks[taskID]
	if st == nil {
		st = &taskRuntime{episodeID: g.episodeID}
		g.tasks[taskID] = st
	}
	if st.episodeID == "" {
		st.episodeID = g.episodeID
	}
	return st
}
func (g *Gate) reviewOrEscalate(ctx context.Context, taskID, fp string, gen uint64, proposal Proposal, failure *FailureEvent, diagNotes []string) (Decision, error) {
	// If Episode reviewer budget already exhausted, stop the turn.
	g.mu.Lock()
	if g.episode.reviewRejects >= uint8(g.opts.MaxReviewBlocks) {
		g.episode.stopped = true
		if g.episode.stopReason == StopReasonNone {
			g.episode.stopReason = StopReasonReviewRejects
		}
		g.metrics.ReviewStops++
		g.mu.Unlock()
		return g.stopTurnDecision(taskID, gen, StopReasonReviewRejects, proposal), nil
	}
	g.mu.Unlock()

	var verdict ReviewVerdict
	if g.opts.Reviewer != nil {
		start := g.opts.Now()
		taskSummary := strings.TrimSpace(proposal.TaskSummary)
		if taskSummary == "" && g.opts.TaskSummary != nil {
			taskSummary = g.opts.TaskSummary()
		}
		v, err := g.opts.Reviewer.Review(ctx, failure, diagNotes, proposal, taskSummary)
		latency := g.opts.Now().Sub(start).Milliseconds()
		g.mu.Lock()
		g.metrics.ReviewLatencyMsSum += latency
		g.metrics.ReviewLatencyCount++
		if err != nil {
			g.metrics.ReviewErrors++
		}
		g.mu.Unlock()
		if err != nil {
			if proposal.PlanTransition {
				return g.askHuman(ctx, taskID, fp, gen, proposal, failure, diagNotes, ChangeScope,
					"The active execution plan changed, but the independent plan reviewer is unavailable.")
			}
			g.mu.Lock()
			g.metrics.RuleContinues++
			g.mu.Unlock()
			return Decision{Allow: true, Generation: gen}, nil
		}
		verdict = normalizeVerdict(v, failure, proposal, diagNotes)
		if verdict.Outcome == ReviewContinue && reviewerContinueKind(verdict.ChangeKind) {
			// Reviewer Continue does NOT reset cumulative rejects. Only real
			// mutation/verification success, a new Episode, or revise does.
			g.mu.Lock()
			g.metrics.ReviewContinues++
			g.mu.Unlock()
			return Decision{
				Allow:                    true,
				AuthorizePlanReplacement: proposal.PlanTransition,
				Generation:               gen,
			}, nil
		}
		if proposal.PlanTransition && reviewerPlanDecision(verdict) {
			return g.askHuman(ctx, taskID, fp, gen, proposal, failure, diagNotes, verdict.ChangeKind, verdict.Rationale)
		}
		blocks := g.recordReviewBlock(taskID, verdict)
		if blocks < g.opts.MaxReviewBlocks {
			return Decision{
				Allow:      false,
				Blocked:    true,
				Message:    reviewerBlockerMessage(verdict, blocks, g.opts.MaxReviewBlocks),
				Generation: gen,
			}, nil
		}
		g.mu.Lock()
		g.episode.stopped = true
		if g.episode.stopReason == StopReasonNone {
			g.episode.stopReason = StopReasonReviewRejects
		}
		g.metrics.ReviewStops++
		g.mu.Unlock()
		return g.stopTurnDecision(taskID, gen, StopReasonReviewRejects, proposal), nil
	}
	if proposal.PlanTransition {
		return g.askHuman(ctx, taskID, fp, gen, proposal, failure, diagNotes, ChangeScope,
			"The active execution plan changed and needs your choice because no independent plan reviewer is configured.")
	}
	g.mu.Lock()
	g.metrics.RuleContinues++
	g.mu.Unlock()
	return Decision{Allow: true, Generation: gen}, nil
}
func (g *Gate) askHuman(ctx context.Context, taskID, fp string, gen uint64, proposal Proposal, failure *FailureEvent, diagNotes []string, kind ChangeKind, rationale string) (Decision, error) {
	failureSource := ""
	failureSummary := ""
	if failure != nil {
		failureSource = failure.SourceAgent
		failureSummary = failure.ErrSummary
	}
	pending := PendingProposal{
		Tool:        proposal.Tool,
		Subject:     proposal.Subject,
		Preview:     proposal.Preview,
		Args:        append(json.RawMessage(nil), proposal.Args...),
		Fingerprint: fp,
		SourceAgent: firstNonEmpty(proposal.AgentID, failureSource),
		ChangeKind:  kind,
		Rationale:   firstNonEmpty(rationale, userFacingReason(kind)),
		Diagnosis:   strings.Join(diagNotes, "\n"),
		Failure:     failureSummary,
		Proposed:    firstNonEmpty(proposal.Subject, proposal.Preview, proposal.Tool),
		PlanBefore:  proposal.PlanBefore,
		PlanAfter:   proposal.PlanAfter,
	}

	if g.opts.Headless || g.opts.EmitPrompt == nil {
		return Decision{
			Allow:      false,
			Blocked:    true,
			Message:    headlessBlockerMessage(pending, failure),
			Generation: gen,
		}, nil
	}

	// Create the waiter channel before EmitPrompt. Resolve may race in as soon
	// as the approval id is known (desktop/bot), so re-key the waiter under the
	// real id immediately after EmitPrompt returns.
	reply := make(chan resolvePayload, 1)
	g.mu.Lock()
	g.metrics.HumanPrompts++
	if st := g.tasks[taskID]; st != nil && st.failureCount() > 1 {
		g.metrics.RepeatPrompts++
	}
	provisional := "pending:" + taskID
	g.waiters[provisional] = reply
	g.taskOf[provisional] = taskID
	g.pending[provisional] = pending
	g.awaiting[taskID] = struct{}{}
	g.mu.Unlock()

	approvalID, err := g.opts.EmitPrompt(ctx, taskID, pending, failure)
	if err != nil {
		g.mu.Lock()
		delete(g.waiters, provisional)
		delete(g.taskOf, provisional)
		delete(g.pending, provisional)
		delete(g.awaiting, taskID)
		g.mu.Unlock()
		return Decision{Allow: false, Blocked: true, Message: "blocked: Auto Guard prompt failed: " + err.Error(), Generation: gen}, err
	}
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		g.mu.Lock()
		delete(g.waiters, provisional)
		delete(g.taskOf, provisional)
		delete(g.pending, provisional)
		delete(g.awaiting, taskID)
		g.mu.Unlock()
		return Decision{Allow: false, Blocked: true, Message: "blocked: Auto Guard prompt returned empty id", Generation: gen}, fmt.Errorf("empty Auto Guard approval id")
	}

	g.mu.Lock()
	// EmitPrompt implementations may bind the real id before emitting, which
	// lets a synchronous frontend resolve the card before EmitPrompt returns.
	// Only re-key a waiter that is still provisional; if both mappings are gone,
	// Resolve already completed and its buffered payload is waiting on reply.
	if provisionalReply, ok := g.waiters[provisional]; ok && provisionalReply != nil {
		delete(g.waiters, provisional)
		delete(g.taskOf, provisional)
		if p, exists := g.pending[provisional]; exists {
			delete(g.pending, provisional)
			g.pending[approvalID] = p
		}
		if existing, exists := g.waiters[approvalID]; exists && existing != nil {
			reply = existing
		} else {
			reply = provisionalReply
			g.waiters[approvalID] = reply
			g.taskOf[approvalID] = taskID
		}
	} else if existing, ok := g.waiters[approvalID]; ok && existing != nil {
		reply = existing
	}
	g.awaiting[taskID] = struct{}{}
	g.mu.Unlock()
	g.persist()

	select {
	case payload := <-reply:
		decision, err := g.decisionFromResolve(payload)
		if err == nil && decision.Allow && proposal.PlanTransition {
			decision.AuthorizePlanReplacement = true
		}
		decision.Generation = gen
		return decision, err
	case <-ctx.Done():
		g.mu.Lock()
		delete(g.waiters, approvalID)
		delete(g.taskOf, approvalID)
		delete(g.pending, approvalID)
		delete(g.resolving, approvalID)
		delete(g.awaiting, taskID)
		g.mu.Unlock()
		g.persist()
		return Decision{Allow: false, Blocked: true, Message: "blocked: Auto Guard confirmation cancelled", Generation: gen}, ctx.Err()
	}
}
func taskGrantScopeKey(proposal Proposal) string {
	// Root task ids span a controller session. TaskScopeID is host-owned and
	// unique per ordinary turn, while goal continuations reuse their delivery
	// scope. Hash it so task-local runtime state never contains raw task text.
	taskScope := strings.TrimSpace(proposal.TaskScopeID)
	if taskScope == "" {
		taskScope = strings.TrimSpace(proposal.TaskSummary)
	}
	return CallFingerprint(
		"task-grant",
		normalizeTaskID(proposal.TaskID),
		taskScope,
		nil,
	)
}

func taskGrantRuntimeKey(semanticKey, taskScope string) string {
	if semanticKey == "" || taskScope == "" {
		return ""
	}
	return semanticKey + "#" + taskScope
}

func (g *Gate) decisionFromResolve(payload resolvePayload) (Decision, error) {
	switch payload.action {
	case ActionContinue, ActionContinueTask:
		return Decision{Allow: true}, nil
	case ActionRevise:
		msg := "blocked: user requested a revised Auto Guard action"
		feedback := strings.TrimSpace(payload.feedback)
		if feedback == "" {
			feedback = DefaultReviseFeedback
		}
		msg += ": " + feedback
		return Decision{Allow: false, Blocked: true, Message: msg}, nil
	default:
		return Decision{Allow: false, Blocked: true, Message: "blocked: unknown Auto Guard action"}, nil
	}
}

// RecordDiagnosis appends a diagnosis note while recovering.
func (g *Gate) RecordDiagnosis(taskID, note string) {
	if g == nil || strings.TrimSpace(note) == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.tasks[normalizeTaskID(taskID)]
	if st == nil || st.lastFailure == nil {
		return
	}
	if appendDiagnosisNote(st.lastFailure, note) {
		g.persistUnlocked()
	}
}

// internals

func (g *Gate) activeMode() bool {
	mode := strings.ToLower(strings.TrimSpace(g.opts.Mode()))
	return mode == "auto"
}

func (g *Gate) recoveryGuidanceLocked(st *taskRuntime) string {
	if st.guidanceSent {
		return ""
	}
	st.guidanceSent = true
	if st.lastFailure != nil && st.lastFailure.evidence.Class == FailureClassTransient {
		return agent.HostRecoveryGuidanceTransientPrefix + " Inspect its current state and output before retrying so partial effects are not duplicated. " +
			"Read-only diagnosis and unrelated work remain available without asking the user; retry the exact operation only after ruling out partial effects."
	}
	return agent.HostRecoveryGuidanceToolFailedPrefix + ", continue unrelated work automatically, and do not ask the user unless a genuine product or plan choice is required. " +
		"Repeated retries of the exact failed operation remain bounded."
}

func diagnosticObservationNote(obs Observation) string {
	tool := clip(strings.TrimSpace(obs.Tool), 120)
	if tool == "" {
		tool = "diagnostic"
	}
	subject := clip(firstNonEmpty(obs.Subject, ArgsSummary(obs.Args, 160)), 160)
	header := tool
	if subject != "" && subject != tool {
		header += " (" + subject + ")"
	}
	output := strings.TrimSpace(obs.Output)
	if output == "" {
		return clipDiagnosisNote(header + ": completed successfully")
	}
	return clipDiagnosisNote(header + ": " + output)
}
func (g *Gate) recordReviewBlock(taskID string, verdict ReviewVerdict) int {
	g.mu.Lock()
	st := g.ensureTaskLocked(taskID)
	// Cumulative across all candidates and TaskIDs inside the Episode.
	if g.episode.reviewRejects < 255 {
		g.episode.reviewRejects++
	}
	blocks := int(g.episode.reviewRejects)
	if st.lastFailure != nil {
		note := "Auto Guard reviewer blocked the proposal: " + firstNonEmpty(verdict.Rationale, string(verdict.ChangeKind))
		appendDiagnosisNote(st.lastFailure, note)
	}
	g.mu.Unlock()
	g.persist()
	return blocks
}
