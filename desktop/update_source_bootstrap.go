package main

import (
	"log/slog"

	"reasonix/internal/config"
)

// ensureDefaultUpdateMirrors seeds the built-in mirror list into the user config
// once, so "mirror acceleration is on by default" holds without making every
// endpoint list depend on an implicit fallback. readMirrorPrefixes stays a pure
// config read: tests that pin their own endpoints never reach the network.
func ensureDefaultUpdateMirrors() {
	cfg, err := config.LoadUserConfigReadOnly()
	if err != nil || cfg == nil {
		return
	}
	if !cfg.UpdateSourceMirrorsEnabled() || len(cfg.Desktop.UpdateMirrors) > 0 {
		return
	}
	path := config.UserConfigPath()
	if path == "" {
		return
	}
	mirrors := make([]config.UpdateMirrorConfig, 0, len(builtinUpdateMirrors))
	for _, url := range builtinUpdateMirrors {
		mirrors = append(mirrors, config.UpdateMirrorConfig{URL: url})
	}
	unlock := config.LockUserConfigEdits()
	defer unlock()
	cfg.SetUpdateMirrors(mirrors)
	if err := cfg.SaveTo(path); err != nil {
		slog.Warn("desktop: could not seed default update mirrors", "err", err)
	}
}
