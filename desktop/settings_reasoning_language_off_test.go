package main

import (
	"strings"
	"testing"

	"reasonix/internal/config"
	"reasonix/internal/control"
)

// off must persist as a first-class value and reach already-open tabs on the
// very next turn, not only after the next boot.
func TestSetReasoningLanguageOffPersistsAndReachesLiveControllers(t *testing.T) {
	isolateDesktopUserDirs(t)
	projectRoot := t.TempDir()

	app := NewApp()
	ctrl := control.New(control.Options{ReasoningLanguage: "auto"})
	app.tabs = map[string]*WorkspaceTab{
		"user": {ID: "user", WorkspaceRoot: projectRoot, Ctrl: ctrl},
	}
	app.activeTabID = "user"

	if err := app.SetReasoningLanguage("off"); err != nil {
		t.Fatalf("SetReasoningLanguage(off): %v", err)
	}
	if view := app.Settings(); view.Agent.ReasoningLanguage != "off" {
		t.Fatalf("Settings().Agent.ReasoningLanguage = %q, want off", view.Agent.ReasoningLanguage)
	}
	cfg := config.LoadForEdit(config.UserConfigPath())
	if cfg.Agent.ReasoningLanguage != "off" || cfg.ReasoningLanguage() != "off" {
		t.Fatalf("saved reasoning language = %q/%q, want off", cfg.Agent.ReasoningLanguage, cfg.ReasoningLanguage())
	}

	// A Chinese prompt that auto would wrap has to stay untouched.
	if got := ctrl.Compose("解释这个模块"); strings.Contains(got, "<reasoning-language>") {
		t.Fatalf("live controller still injected a reasoning block after off: %q", got)
	}
}
