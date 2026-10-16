package config

import (
	"fmt"
)

// SetDesktopThemeSchedule stores the dark-window bounds for theme=schedule.
// Either side may be empty to clear the schedule; malformed clocks are rejected
// so a typo never silently flips the app dark.
func (c *Config) SetDesktopThemeSchedule(darkStart, darkEnd string) error {
	start := normalizeThemeClock(darkStart)
	end := normalizeThemeClock(darkEnd)
	if darkStart != "" && start == "" {
		return fmt.Errorf("theme schedule start %q: must be HH:MM", darkStart)
	}
	if darkEnd != "" && end == "" {
		return fmt.Errorf("theme schedule end %q: must be HH:MM", darkEnd)
	}
	c.Desktop.ThemeScheduleDarkStart = start
	c.Desktop.ThemeScheduleDarkEnd = end
	return nil
}

// SetFoldIndex toggles the folded-work index on compaction summaries (and the
// recall tool that reads it).
func (c *Config) SetFoldIndex(enabled bool) error {
	c.Agent.FoldIndex = &enabled
	return nil
}
