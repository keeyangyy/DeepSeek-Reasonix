package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sharedUserConfig is a user config as it looks on a machine that runs the
// Wails build and the Studio build against the same file. It deliberately
// carries every shape the Wails build does not model:
//
//   - Studio-only [desktop] keys (theme_pack, welcomed, surface_slots, editor)
//   - an unknown hand-written key in each known table
//   - an element field only Studio writes, on two [[providers]] and one [[plugins]]
//   - an MCP command table this build does not decode
//   - a top-level table this build does not know at all
//   - config_version 12 (ahead of this build's own)
const sharedUserConfig = `config_version = 12
default_model = "deepseek-flash"
language = "zh"

# ---- hand-written notes that must survive ----
[desktop]
language = "zh"
theme = "light"
theme_pack = "obsidian"
welcomed = true
surface_slots = { "ext:panel" = "right" }
editor = "code"
handwritten_desktop_key = "keep"

[agent]
temperature = 0.1
unknown_agent_key = 42

[ui]
unknown_ui_key = "keep"

[cli]
update_channel = "preview"
editor = "cursor"
unknown_cli_key = "keep"

[[providers]]
name = "deepseek"
kind = "openai"
base_url = "https://api.deepseek.com"
models = ["deepseek-v4-flash"]
studio_catalog_id = "deepseek-v4"
studio_extra = { a = 1 }

[[providers]]
name = "other"
kind = "openai"
base_url = "https://example.com/v1"
studio_catalog_id = "other-id"

[[plugins]]
name = "ctx7"
command = "npx"
args = ["-y", "ctx7"]
studio_plugin_key = "keep-me"

[mcp_servers."ctx7"]
command = "npx"
args = ["-y", "ctx7"]
studio_mcp_key = "keep-me"

[checkpoints]
retain_turns = 7
`

// requireSharedConfigFieldLoss fails unless every marker in sharedUserConfig
// survives the save. These are exactly the fields a whole render would drop.
func requireSharedConfigFieldLoss(t *testing.T, got string) {
	t.Helper()
	for _, want := range []string{
		"theme_pack", "welcomed", "surface_slots", "editor = \"code\"", "handwritten_desktop_key",
		"unknown_agent_key", "unknown_ui_key", "unknown_cli_key",
		"studio_catalog_id", "studio_extra", "studio_plugin_key", "studio_mcp_key",
		"# ---- hand-written notes that must survive ----",
		"[checkpoints]", "retain_turns = 7",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("save dropped %q\n--- got ---\n%s", want, got)
		}
	}
}

// TestSwitchingLanguageKeepsEveryOtherSetting is the regression test for the
// reported bug: switching the desktop language must touch only the two agreed
// fields — [desktop].language and top-level language — and leave every other
// byte, including fields only another build writes, as it was.
func TestSwitchingLanguageKeepsEveryOtherSetting(t *testing.T) {
	path := seedUserConfig(t, sharedUserConfig)

	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := cfg.SetDesktopLanguage("en"); err != nil {
		t.Fatalf("SetDesktopLanguage: %v", err)
	}
	if err := cfg.SetLanguage("en"); err != nil {
		t.Fatalf("SetLanguage: %v", err)
	}
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	requireSharedConfigFieldLoss(t, got)
	if !strings.Contains(got, `language = "en"`) {
		t.Errorf("desktop language not written\n--- got ---\n%s", got)
	}
	// Exactly two kinds of line may differ from the original file: the two
	// language keys (rewritten in place) and the retired [cli].update_channel
	// line (removed by design). Everything else must be byte-identical.
	before := strings.Split(sharedUserConfig, "\n")
	after := strings.Split(got, "\n")
	if len(before)-len(after) != 1 {
		t.Fatalf("line count %d -> %d, want exactly the retired key removed\n--- got ---\n%s", len(before), len(after), got)
	}
	remaining := map[string]int{}
	for _, line := range after {
		remaining[line]++
	}
	for _, line := range before {
		if remaining[line] > 0 {
			remaining[line]--
			continue
		}
		if strings.Contains(line, `update_channel = "preview"`) {
			continue // retired key, removed on purpose
		}
		if strings.Contains(line, "language") {
			continue // rewritten in place; covered by the checks below
		}
		t.Errorf("unexpected line change: %q\n--- got ---\n%s", line, got)
	}
	if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
		t.Errorf("language switch rewrote the whole file: %v", backups)
	}
}

// TestRepeatedLanguageSwitchesStayInPlace covers zh -> en -> auto -> zh on one
// file: the auto step is the one that used to fall back to a whole render.
func TestRepeatedLanguageSwitchesStayInPlace(t *testing.T) {
	path := seedUserConfig(t, sharedUserConfig)

	for _, lang := range []string{"en", "auto", "zh", "en"} {
		cfg, err := LoadForEditReadOnlyStrict(path)
		if err != nil {
			t.Fatalf("load for %q: %v", lang, err)
		}
		if err := cfg.SetDesktopLanguage(lang); err != nil {
			t.Fatalf("SetDesktopLanguage(%q): %v", lang, err)
		}
		if err := cfg.SetLanguage(lang); err != nil {
			t.Fatalf("SetLanguage(%q): %v", lang, err)
		}
		if err := cfg.SaveTo(path); err != nil {
			t.Fatalf("SaveTo(%q): %v", lang, err)
		}
		got := readUserConfig(t, path)
		requireSharedConfigFieldLoss(t, got)
		if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
			t.Fatalf("switch to %q rewrote the whole file: %v\n%s", lang, backups, got)
		}
	}

	reloaded, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.DesktopLanguage(); got != "en" {
		t.Errorf("desktop language after reload = %q, want en", got)
	}
	if got := reloaded.ResponseLanguage(); got != "en" {
		t.Errorf("response language after reload = %q, want en", got)
	}
}

// TestProviderAndPluginEditsKeepElementFields covers the array-of-tables path:
// changing one element must not drop the element fields this build does not
// model, and must leave the sibling elements alone.
func TestProviderAndPluginEditsKeepElementFields(t *testing.T) {
	path := seedUserConfig(t, sharedUserConfig)

	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for i := range cfg.Providers {
		if cfg.Providers[i].Name == "deepseek" {
			cfg.Providers[i].BaseURL = "https://api.deepseek.com/v1"
		}
	}
	cfg.Plugins[0].Args = append(cfg.Plugins[0].Args, "--verbose")
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	requireSharedConfigFieldLoss(t, got)
	if !strings.Contains(got, "https://api.deepseek.com/v1") {
		t.Errorf("provider edit not applied\n--- got ---\n%s", got)
	}
	if !strings.Contains(got, "--verbose") {
		t.Errorf("plugin edit not applied\n--- got ---\n%s", got)
	}
	if n := strings.Count(got, "studio_catalog_id"); n != 2 {
		t.Errorf("studio_catalog_id appears %d times, want 2 (one per provider)", n)
	}
	reloaded, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(reloaded.Providers) != 2 || len(reloaded.Plugins) != 1 {
		t.Fatalf("providers=%d plugins=%d, want 2/1", len(reloaded.Providers), len(reloaded.Plugins))
	}
}

// TestRetiredCLIKeyGoesWithoutDroppingTheRestOfItsTable covers the retired
// [cli].update_channel migration: the key goes, the rest of the table stays.
func TestRetiredCLIKeyGoesWithoutDroppingTheRestOfItsTable(t *testing.T) {
	path := seedUserConfig(t, sharedUserConfig)

	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg.Agent.Temperature = 0.5
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	requireSharedConfigFieldLoss(t, got)
	if strings.Contains(got, `update_channel = "preview"`) {
		t.Errorf("retired [cli].update_channel survived\n--- got ---\n%s", got)
	}
	if !strings.Contains(got, `editor = "cursor"`) || !strings.Contains(got, "unknown_cli_key") {
		t.Errorf("save dropped the rest of [cli]\n--- got ---\n%s", got)
	}
}

// TestRefusedSaveLeavesTheFileByteForByte covers requirement 7: a save that
// cannot be expressed in place fails loudly and writes nothing. Two provider
// elements sharing one name cannot be matched across a save, so the element-wise
// merge must refuse instead of guessing which one the edit meant.
func TestRefusedSaveLeavesTheFileByteForByte(t *testing.T) {
	const body = `config_version = 12

[desktop]
language = "zh"
theme_pack = "obsidian"

[[providers]]
name = "dup"
kind = "openai"
base_url = "https://a.example/v1"
studio_catalog_id = "first"

[[providers]]
name = "dup"
kind = "openai"
base_url = "https://b.example/v1"
studio_catalog_id = "second"

[checkpoints]
retain_turns = 7
`
	path := seedUserConfig(t, body)

	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("providers = %d, want the two hand-written entries", len(cfg.Providers))
	}
	cfg.Providers[0].BaseURL = "https://changed.example/v1"
	err = cfg.SaveTo(path)
	if err == nil {
		t.Fatalf("SaveTo accepted a change it cannot express in place\n--- got ---\n%s", readUserConfig(t, path))
	}
	if !strings.Contains(err.Error(), "left unchanged") {
		t.Errorf("error does not say the file was left unchanged: %v", err)
	}
	if got := readUserConfig(t, path); got != body {
		t.Errorf("refused save modified the file\n--- got ---\n%s", got)
	}
	if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
		t.Errorf("refused save left a rewrite backup: %v", backups)
	}
}

// TestFirstSaveStillRendersTheTemplate keeps the one whole-render case: a file
// that does not exist yet has no user content to lose.
func TestFirstSaveStillRendersTheTemplate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	path := filepath.Join(home, "config.toml")

	cfg := Default()
	cfg.UI.Theme = "light"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, want := range []string{"config_version", "[ui]", `theme = "light"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("first save missing %q\n--- got ---\n%s", want, raw)
		}
	}
}
