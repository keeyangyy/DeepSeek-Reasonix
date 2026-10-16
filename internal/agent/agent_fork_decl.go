package agent

// foldIndexEnabled reports whether compaction digests carry a folded-work
// index. Nil keeps the feature on: the config default is enabled, and an
// agent built without an explicit setting must not silently lose it.
func (a *Agent) foldIndexEnabled() bool {
	return a.foldIndex == nil || *a.foldIndex
}
