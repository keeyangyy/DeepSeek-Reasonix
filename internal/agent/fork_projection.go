package agent

import (
	"reasonix/internal/provider"
)

// InheritContextProjectionForFork installs the parent's compacted view on this
// session, which must be a fresh fork of the parent's transcript. A fork that
// lands inside the parent's covered region trims the covered count to the fork
// boundary instead of dropping the projection, so the fork keeps the compacted
// context (a few messages) rather than replaying the full canonical history.
func (s *Session) InheritContextProjectionForFork(parentPath, targetPath string, parent []provider.Message) (bool, error) {
	if s == nil {
		return false, nil
	}
	return inheritContextProjectionForFork(parentPath, targetPath, parent, s.Snapshot())
}

func inheritContextProjectionForFork(parentPath, targetPath string, parent, forked []provider.Message) (bool, error) {
	if _, ok, err := LoadCompactionState(targetPath); err != nil {
		return false, err
	} else if ok {
		// The fork already owns a sidecar: never overwrite another writer's state.
		return false, nil
	}
	st, ok, err := LoadCompactionState(parentPath)
	if err != nil {
		return false, err
	}
	if !ok || len(st.Projection.Messages) == 0 {
		return false, nil
	}
	migratePromotedCoveredPrefixHash(&st, parent)
	// The parent projection must still describe the parent's own transcript; a
	// fork never borrows a stale or unrelated view.
	if !projectionContentValid(st, parent) {
		return false, nil
	}
	// The fork must be an exact provider-visible prefix of the parent, or the
	// parent's covered prefix says nothing about what this fork inherits.
	// Identity is local (a fork re-identifies its copies), so compare the wire view.
	if len(forked) == 0 || len(forked) > len(parent) || !sameProviderVisiblePrefix(parent, forked) {
		return false, nil
	}
	covered := st.Projection.CoveredCount
	if covered > len(forked) {
		// The fork cut inside the covered region: the compacted body already
		// represents everything the fork inherits, so lowering the covered count
		// keeps the compacted view (it may still mention the cut tail).
		trimmed := len(forked)
		hash := coveredPrefixHash(forked, trimmed)
		if hash == "" {
			return false, nil
		}
		st.Projection.CoveredCount = trimmed
		st.Projection.CoveredPrefixHash = hash
		st.Projection.PinnedContextHash = pinnedContextCoverageHash(forked, trimmed)
		// Source/projection token counts stay the parent's: they describe the
		// compaction that produced this body, not the trimmed covered prefix.
		if receipt := st.LastReceipt; receipt != nil {
			updated := *receipt
			updated.CoveredCount = trimmed
			updated.CoveredPrefixHash = hash
			st.LastReceipt = &updated
		}
	}
	if err := SaveCompactionState(targetPath, st); err != nil {
		return false, err
	}
	return true, nil
}

// sameProviderVisiblePrefix reports whether forked carries exactly the
// provider-visible messages of parent's leading slice.
func sameProviderVisiblePrefix(parent, forked []provider.Message) bool {
	if len(forked) == 0 || len(forked) > len(parent) {
		return false
	}
	want := coveredPrefixHash(parent, len(forked))
	got := coveredPrefixHash(forked, len(forked))
	return want != "" && want == got
}
