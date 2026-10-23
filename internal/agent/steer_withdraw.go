package agent

// WithdrawSteer drops a durable steer the user handed back to the queue.
//
// The store transition alone is not enough: the entry also has to leave the
// agent's own queue. Left in place, its loader would still run at consume time,
// the store would refuse the compare-and-transition, and the transcript would
// report an unapplied steer the user never asked for.
func (a *Agent) WithdrawSteer(itemID string) bool {
	if a == nil || itemID == "" {
		return false
	}
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	for i, entry := range a.steerQueue {
		if entry.itemID != itemID {
			continue
		}
		// Copy instead of splicing in place so a concurrent reader holding the
		// previous slice header keeps a consistent view.
		rest := make([]steerEntry, 0, len(a.steerQueue)-1)
		rest = append(rest, a.steerQueue[:i]...)
		rest = append(rest, a.steerQueue[i+1:]...)
		a.steerQueue = rest
		a.steerConsumed = len(rest) == 0
		return true
	}
	return false
}