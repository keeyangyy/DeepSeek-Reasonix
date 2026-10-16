package main

import (
	"reasonix/internal/config"
)

// cfgDesktopThemeScheduleStart reads the persisted dark-window start for
// theme=schedule ("HH:MM", "" when unconfigured).
func (a *App) cfgDesktopThemeScheduleStart() string {
	cfg := config.LoadForEdit(config.UserConfigPath())
	return cfg.DesktopThemeScheduleDarkStart()
}

// cfgDesktopThemeScheduleEnd reads the persisted dark-window end for
// theme=schedule ("HH:MM", "" when unconfigured).
func (a *App) cfgDesktopThemeScheduleEnd() string {
	cfg := config.LoadForEdit(config.UserConfigPath())
	return cfg.DesktopThemeScheduleDarkEnd()
}
