package agent

// explicitCompressionSnapshotCurrent 判断压缩快照是否仍代表它开始时的上下文。
//
// 关键点：校验用快照里**捕获的会话**，而不是实时的 a.sess.conversation。
// 单标签页切换会话走 controller.Resume → SetSession，同一个 Agent 的会话对象
// 会被换掉；此时若拿实时会话比对，进行中的压缩一律被判过期，用户已经等完的
// 摘要就被整份丢弃，压缩投影也就没生效。
//
// 内存里的投影版本与 generation 只在「目标会话仍是当前会话」时才有意义：
// 切走之后它们属于新会话，不该拿来否决这次压缩。
func (a *Agent) explicitCompressionSnapshotCurrent(snap explicitCompressionSnapshot) bool {
	conv := snap.conversation
	if conv == nil {
		conv = a.sess.conversation
	}
	current, version := conv.snapshotMessagesVersion()
	transcriptOK := version == snap.transcriptVersion &&
		len(current) == len(snap.canonical) &&
		coveredPrefixHash(current, len(current)) == snap.coveredHash &&
		a.currentPromptCacheKey() == snap.promptCacheKey
	if !transcriptOK {
		return false
	}
	a.sess.compactionMu.Lock()
	stillCurrent := snap.sessionPath == "" || snap.sessionPath == a.sess.path
	projectionVersion := a.sess.compactionState.Projection.ProjectionVersion
	generation := a.sess.compactionState.Generation
	a.sess.compactionMu.Unlock()
	if !stillCurrent {
		return true
	}
	return projectionVersion == snap.projectionVersion && generation == snap.generation
}
