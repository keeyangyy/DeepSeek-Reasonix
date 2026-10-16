package main

import (
	"reasonix/internal/config"
)

// SetFoldIndex toggles the folded-work index on compaction summaries (and the
// recall tool that reads it). The setting applies from the next compaction on;
// existing summaries keep whatever index they already carry.
func (a *App) SetFoldIndex(enabled bool) error {
	return a.applyConfigChange(func(c *config.Config) error {
		return c.SetFoldIndex(enabled)
	})
}
