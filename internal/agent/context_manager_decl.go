package agent

// maintenanceDecision reports whether this turn's maintenance is suppressed and
// whether the fold is stale. A stale fold is never suppressed: skipping it would
// replay the entire session (measured 1092 msgs / 5.6MB → upstream 400).
func (a *Agent) maintenanceDecision(policy ContextPreparePolicy, inputHash string, viewEst, est, hard int) (stale, suppressed bool) {
	stale = a.projectionStaleForRebuild()
	if stale {
		return stale, false
	}
	if blocked, _ := a.contextMaintenanceBlocked(inputHash, viewEst); blocked &&
		policy.Trigger != CompactionTriggerManual && policy.Trigger != CompactionTriggerOverflow && est < hard {
		return stale, true
	}
	if a.sess.compaction.stuck && policy.Trigger == CompactionTriggerPressure && est < hard {
		return stale, true
	}
	return stale, false
}
