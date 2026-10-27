package control

import "strings"

// ReleaseInboxItem returns an accepted steer to the next-turn queue. The item's
// body was never inlined into the agent, so dropping it back to queued makes the
// pending loader fail closed and the guidance is not applied to the running turn.
func (c *Controller) ReleaseInboxItem(id string) error {
	st, err := c.ensureInbox()
	if err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	if err := st.ReleaseAcceptedSteer(id); err != nil {
		return err
	}
	// The turn-end sweep only acks running/steer_* rows, so a released row must
	// stop being tracked here or it would be read as a lost acknowledgement.
	c.inbox.mu.Lock()
	c.inbox.untrackActive(id)
	c.inbox.mu.Unlock()
	// Drop the in-memory admission too. The store transition alone leaves the
	// entry queued inside the agent, whose loader would then fail at consume time
	// and report the guidance as unapplied.
	if c.executor != nil {
		c.executor.WithdrawSteer(id)
	}
	return nil
}
