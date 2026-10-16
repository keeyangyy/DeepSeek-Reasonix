package config

import (
	"fmt"
	"strconv"
	"strings"
)

// normalizeThemeClock validates a "HH:MM" clock value (00:00–23:59) used by
// the desktop theme schedule. Empty input is valid (means unconfigured).
func normalizeThemeClock(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return ""
	}
	hour, errH := strconv.Atoi(parts[0])
	minute, errM := strconv.Atoi(parts[1])
	if errH != nil || errM != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return ""
	}
	return fmt.Sprintf("%02d:%02d", hour, minute)
}

// DesktopThemeScheduleDarkStart returns the normalized dark-window start
// ("HH:MM") for theme=schedule; "" when unset or malformed.
func (c *Config) DesktopThemeScheduleDarkStart() string {
	return normalizeThemeClock(c.Desktop.ThemeScheduleDarkStart)
}

// DesktopThemeScheduleDarkEnd returns the normalized dark-window end ("HH:MM")
// for theme=schedule; "" when unset or malformed.
func (c *Config) DesktopThemeScheduleDarkEnd() string {
	return normalizeThemeClock(c.Desktop.ThemeScheduleDarkEnd)
}

// FoldIndexEnabled reports whether compaction digests carry a folded-work
// index with recall. Default true: the index is what makes folded content
// reachable again, and a host that never says anything keeps it.
func (c *Config) FoldIndexEnabled() bool {
	if c == nil || c.Agent.FoldIndex == nil {
		return true
	}
	return *c.Agent.FoldIndex
}
