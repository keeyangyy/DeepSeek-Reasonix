package agent

// projectionStaleForRebuild reports that a fold exists whose covered prefix no
// longer matches the canonical transcript (history edited/replayed): the request
// would re-send the whole session. Lineage-only mismatch is not stale (rebindable).
func (a *Agent) projectionStaleForRebuild() bool {
	if a == nil || a.sess.conversation == nil {
		return false
	}
	msgs, _ := a.sess.conversation.snapshotMessagesVersion()
	a.sess.compactionMu.Lock()
	st := a.sess.compactionState
	a.sess.compactionMu.Unlock()
	if len(st.Projection.Messages) == 0 {
		return false
	}
	return !projectionContentValid(st, msgs)
}
