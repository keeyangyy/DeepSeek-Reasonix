package main

import (
	"testing"

	"reasonix/internal/config"
)

func TestEnsureDefaultUpdateMirrorsSeedsBuiltinsOnce(t *testing.T) {
	t.Setenv("REASONIX_HOME", t.TempDir())

	ensureDefaultUpdateMirrors()
	cfg, err := config.LoadUserConfigReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Desktop.UpdateMirrors) != len(builtinUpdateMirrors) {
		t.Fatalf("seeded %d mirrors, want %d", len(cfg.Desktop.UpdateMirrors), len(builtinUpdateMirrors))
	}
	if !cfg.UpdateSourceMirrorsEnabled() {
		t.Fatal("seeding must leave mirror acceleration on")
	}

	cfg.SetUpdateMirrors([]config.UpdateMirrorConfig{{URL: "https://example.com"}})
	if err := cfg.SaveTo(config.UserConfigPath()); err != nil {
		t.Fatal(err)
	}
	ensureDefaultUpdateMirrors()
	got, err := config.LoadUserConfigReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Desktop.UpdateMirrors) != 1 || got.Desktop.UpdateMirrors[0].URL != "https://example.com" {
		t.Fatalf("a saved list was overwritten: %+v", got.Desktop.UpdateMirrors)
	}
}

func TestEnsureDefaultUpdateMirrorsRespectsSwitch(t *testing.T) {
	t.Setenv("REASONIX_HOME", t.TempDir())

	cfg := config.Default()
	cfg.SetUpdateSourceEnabled(false)
	if err := cfg.SaveTo(config.UserConfigPath()); err != nil {
		t.Fatal(err)
	}
	ensureDefaultUpdateMirrors()
	got, err := config.LoadUserConfigReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Desktop.UpdateMirrors) != 0 {
		t.Fatalf("seeded mirrors while the switch is off: %+v", got.Desktop.UpdateMirrors)
	}
}
