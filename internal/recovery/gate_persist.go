package recovery

import (
	"strings"
)

// FlushPersistence waits until every snapshot already scheduled for key has
// finished. Session destruction uses this before removing sidecars so a late
// asynchronous write cannot resurrect an artifact that was just deleted.
func (g *Gate) FlushPersistence(key string) {
	if g == nil || g.opts.Persist == nil {
		return
	}
	g.persistMu.Lock()
	for g.persistPending[key] > 0 {
		g.persistCond.Wait()
	}
	g.persistMu.Unlock()
}

// Snapshot returns a live debug copy of task state (may include budgets).
func (g *Gate) Snapshot() Snapshot {
	if g == nil {
		return Snapshot{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.snapshotLocked(false)
}

// PersistenceSnapshot returns the disk projection: historical last_failure
// evidence only. Active locks, Episode counters, generation, and waiters never
// appear.
func (g *Gate) PersistenceSnapshot() Snapshot {
	if g == nil {
		return Snapshot{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.snapshotLocked(true)
}

func (g *Gate) snapshotLocked(persistence bool) Snapshot {
	// Map task id -> live approval id for observability. Restore always drops
	// these fields so a restart never replays a transient authorization.
	approvalByTask := map[string]string{}
	if !persistence {
		for approvalID, taskID := range g.taskOf {
			if strings.HasPrefix(approvalID, "pending:") {
				continue
			}
			approvalByTask[taskID] = approvalID
		}
	}
	out := Snapshot{Tasks: map[string]*TaskState{}}
	for id, st := range g.tasks {
		var cp *TaskState
		if persistence {
			cp = st.toPersistenceState()
		} else {
			phase := PhaseDiagnosing
			if _, waiting := g.awaiting[id]; waiting {
				phase = PhaseAwaitingDecision
			}
			cp = st.toTaskState(phase)
		}
		if cp == nil {
			continue
		}
		if !persistence {
			if aid := approvalByTask[id]; aid != "" {
				cp.ApprovalID = aid
				cp.Phase = PhaseAwaitingDecision
			}
			// Project shared Episode budgets onto each task for live debug views.
			cp.ReviewBlocks = int(g.episode.reviewRejects)
			cp.EpisodeStopped = g.episode.stopped
			cp.StopReason = string(g.episode.stopReason)
			if cp.EpisodeID == "" {
				cp.EpisodeID = g.episodeID
			}
		}
		out.Tasks[id] = cp
	}
	return out
}
func (g *Gate) persist() {
	if g == nil || g.opts.Persist == nil {
		return
	}
	// Disk never receives active lock state.
	g.schedulePersist(g.PersistenceSnapshot(), false)
}

func (g *Gate) persistUnlocked() {
	// Caller holds g.mu.
	if g == nil || g.opts.Persist == nil {
		return
	}
	g.schedulePersist(g.snapshotLocked(true), true)
}

func (g *Gate) schedulePersist(snap Snapshot, async bool) {
	if g == nil || g.opts.Persist == nil {
		return
	}
	key := ""
	if g.opts.PersistenceKey != nil {
		key = g.opts.PersistenceKey()
	}
	g.persistMu.Lock()
	g.persistSeq++
	seq := g.persistSeq
	g.persistPending[key]++
	g.persistMu.Unlock()
	write := func() {
		g.persistMu.Lock()
		defer g.persistMu.Unlock()
		defer func() {
			g.persistPending[key]--
			if g.persistPending[key] == 0 {
				delete(g.persistPending, key)
				delete(g.persistDone, key)
				g.persistCond.Broadcast()
			}
		}()
		if seq < g.persistDone[key] {
			return
		}
		g.opts.Persist(key, snap)
		g.persistDone[key] = seq
	}
	if async {
		go write()
		return
	}
	write()
}
