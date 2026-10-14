package recovery

import (
	"fmt"
	"strings"
)

// BeginEpisode rotates into a fresh Recovery Episode. Failure, reviewer, and
// stop budgets clear. Explicit task grants and TaskScope authorizations are
// preserved. Call on: real user messages, Plan "start execution", Recovery
// "try another approach", real tool-approval mode changes, and new Session /
// Controller restore. Same-value mode replays must not call this.
func (g *Gate) BeginEpisode() {
	if g == nil {
		return
	}
	dismissed := g.beginEpisodeLockedCollect(true)
	g.finishDismissed(dismissed)
	g.persist()
}

// OnModeChange rotates Episode and generation when the tool-approval mode
// actually changes. Same-value replays (desktop hydration/reconcile) are no-ops
// so in-flight Auto state is not wiped. Returns dismissed recovery approval ids
// so the controller can clear matching cards outside the gate lock.
func (g *Gate) OnModeChange(mode string) []string {
	if g == nil {
		return nil
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		return nil
	}
	g.mu.Lock()
	if g.haveMode && g.lastMode == mode {
		g.mu.Unlock()
		return nil
	}
	// First observation only pins the baseline mode (desktop hydrate / initial
	// ApplyToolApprovalMode). Same-value later replays are no-ops above; a real
	// change rotates Episode and generation.
	if !g.haveMode {
		g.lastMode = mode
		g.haveMode = true
		g.mu.Unlock()
		return nil
	}
	g.lastMode = mode
	g.metrics.ModeResets++
	dismissed := g.beginEpisodeLockedCollect(false)
	// Bump generation even when episode collection already did — mode switch
	// must invalidate in-flight observations.
	if g.generation == 0 {
		g.generation = 1
	}
	ids := make([]string, 0, len(dismissed))
	for _, d := range dismissed {
		ids = append(ids, d.id)
	}
	g.mu.Unlock()
	g.finishDismissed(dismissed)
	g.persist()
	return ids
}

// beginEpisodeLockedCollect must be called with g.mu held when alreadyLocked is
// false it acquires the lock. When alreadyHeld is true, caller holds g.mu.
func (g *Gate) beginEpisodeLockedCollect(lock bool) []dismissedWaiter {
	if lock {
		g.mu.Lock()
	}
	g.episodeSeq++
	if g.episodeSeq == 0 {
		g.episodeSeq = 1
	}
	g.episodeID = fmt.Sprintf("ep:%d", g.episodeSeq)
	g.generation++
	if g.generation == 0 {
		g.generation = 1
	}
	g.metrics.EpisodeRotations++
	// Episode-level hard-stop budgets reset for every TaskID together.
	g.episode.clear()
	// Clear task-local operation counters; preserve task grants.
	for id, st := range g.tasks {
		if st == nil {
			delete(g.tasks, id)
			continue
		}
		grants := st.taskGrants
		grantScope := st.taskGrantScope
		st.clearTaskRecoveryState()
		st.episodeID = g.episodeID
		st.taskGrants = grants
		st.taskGrantScope = grantScope
		if !st.hasTaskGrants() && st.empty() {
			delete(g.tasks, id)
		}
	}
	dismissed := g.collectWaitersLocked(resolvePayload{
		action:   ActionRevise,
		feedback: "Tool approval mode or recovery episode changed. Re-evaluate under the new mode; the previous proposal was not approved.",
	})
	if lock {
		g.mu.Unlock()
	}
	return dismissed
}

func (g *Gate) collectWaitersLocked(payload resolvePayload) []dismissedWaiter {
	out := make([]dismissedWaiter, 0, len(g.waiters))
	for id, ch := range g.waiters {
		taskID := g.taskOf[id]
		out = append(out, dismissedWaiter{id: id, taskID: taskID, reply: ch, payload: payload})
		delete(g.waiters, id)
		delete(g.taskOf, id)
		delete(g.pending, id)
		delete(g.resolving, id)
		delete(g.awaiting, taskID)
	}
	return out
}

func (g *Gate) finishDismissed(dismissed []dismissedWaiter) {
	for _, d := range dismissed {
		if d.reply == nil {
			continue
		}
		select {
		case d.reply <- d.payload:
		default:
		}
	}
}

// Metrics returns a copy of content-free counters accumulated since gate
// construction or the most recent DrainMetrics call.
func (g *Gate) Metrics() Metrics {
	if g == nil {
		return Metrics{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.metrics
}

// DrainMetrics atomically returns and clears recovery counters accumulated
// since the last drain. Desktop telemetry uses this delta API at TurnDone so a
// historical event is never counted again on later turns.
func (g *Gate) DrainMetrics() Metrics {
	if g == nil {
		return Metrics{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	out := g.metrics
	g.metrics = Metrics{}
	return out
}

// MarkFinalizationOffered records that the agent was given its one summarize-only
// round after an Episode stop. Subsequent tool proposals while still stopped
// should surface RecoveryPauseError.
func (g *Gate) MarkFinalizationOffered(taskID string) {
	if g == nil {
		return
	}
	_ = taskID
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.episode.stopped {
		g.episode.finalizationOffered = true
	}
}

// ConsumeFinalization reports whether the finalization round already ran and
// the model still attempted tools. Also marks it consumed on first true check
// after offered. Finalization is Episode-scoped (shared by all TaskIDs).
func (g *Gate) ConsumeFinalization(taskID string) (offered, alreadyConsumed bool) {
	if g == nil {
		return false, false
	}
	_ = taskID
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.episode.stopped {
		return false, false
	}
	offered = g.episode.finalizationOffered
	alreadyConsumed = g.episode.finalizationConsumed
	if offered && !alreadyConsumed {
		g.episode.finalizationConsumed = true
	}
	return offered, alreadyConsumed
}

// EpisodeStopped reports whether the shared Recovery Episode is exhausted for
// any TaskID (root or sub-agent).
func (g *Gate) EpisodeStopped(taskID string) bool {
	if g == nil {
		return false
	}
	_ = taskID
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.episode.stopped
}

// clearNoProgressLocked clears Episode totals and the observing task's local
// counters after real mutation/verification success. Caller holds g.mu.
func (g *Gate) clearNoProgressLocked(taskID string, st *taskRuntime) {
	g.episode.clear()
	if st != nil {
		st.clearTaskRecoveryState()
		st.episodeID = g.episodeID
		if !st.hasTaskGrants() {
			delete(g.tasks, taskID)
		}
	}
}
