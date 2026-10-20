package control

import "reasonix/internal/agent"

// updateSessionListingProjectionIfCurrent dispatches to the authority-fenced
// variant when the session requires a write authority. Model-only changes need
// not change the transcript digest, so the digest CAS alone cannot reject a
// retired runtime's delayed listing publication.
func updateSessionListingProjectionIfCurrent(
	s *agent.Session, path, modelRef, preview string, turns int, markActivity bool, persisted agent.PersistedState,
) error {
	if !s.WriteAuthorityRequired() {
		_, err := agent.UpdateSessionListingProjectionIfCurrent(path, modelRef, preview, turns, markActivity, persisted)
		return err
	}
	_, err := agent.UpdateOwnedSessionListingProjectionIfCurrent(path, modelRef, preview, turns, markActivity, persisted, s.WriteAuthority())
	return err
}
