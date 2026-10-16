package main

import (
	"reasonix/internal/config"
)

// SetDesktopThemeSchedule stores the dark-window bounds for theme=schedule.
func (a *App) SetDesktopThemeSchedule(darkStart, darkEnd string) error {
	return a.applyConfigOnly(func(c *config.Config) error { return c.SetDesktopThemeSchedule(darkStart, darkEnd) })
}
