package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// userConfigWithForeignTables is a user config as the 1.x and Studio lines leave
// it: config_version 12, hand-written comments, and tables this build neither
// decodes nor renders ([checkpoints], [browser]).
const userConfigWithForeignTables = `config_version = 12
default_model = "deepseek-flash"

# 我的主题设置
[ui]
theme = "dark"

[checkpoints]
retain_turns = 7
blob_quota_bytes = 104857600

[browser]
headless = true

[[providers]]
name = "deepseek-flash"
kind = "openai"
base_url = "https://api.deepseek.com"
`

func seedUserConfig(t *testing.T, body string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	path := filepath.Join(home, "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("seed user config: %v", err)
	}
	return path
}

func readUserConfig(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read user config: %v", err)
	}
	return string(raw)
}

// requireLinesSameExcept fails when any line other than the one the save was
// meant to touch differs: the acceptance bar for a shared config file. The new
// line may carry a trailing comment, which the renderer writes for some keys.
func requireLinesSameExcept(t *testing.T, before, after, oldLine, newLine string) {
	t.Helper()
	beforeLines := strings.Split(before, "\n")
	afterLines := strings.Split(after, "\n")
	if len(beforeLines) != len(afterLines) {
		t.Fatalf("line count changed %d -> %d\n--- before ---\n%s\n--- after ---\n%s",
			len(beforeLines), len(afterLines), before, after)
	}
	for i := range beforeLines {
		if beforeLines[i] == afterLines[i] {
			continue
		}
		if beforeLines[i] != oldLine || !strings.HasPrefix(afterLines[i], newLine) {
			t.Errorf("line %d changed beyond the edited key: %q -> %q", i+1, beforeLines[i], afterLines[i])
		}
	}
}

// TestSavingOneSettingKeepsForeignTablesAndBytes is the acceptance test for the
// shared user config: change one setting, and every other byte of the file —
// including the tables this build does not decode — stays as it was.
func TestSavingOneSettingKeepsForeignTablesAndBytes(t *testing.T) {
	path := seedUserConfig(t, userConfigWithForeignTables)

	cfg := LoadForEdit(path)
	cfg.UI.Theme = "light"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	for _, want := range []string{
		"[checkpoints]\nretain_turns = 7\nblob_quota_bytes = 104857600",
		"[browser]\nheadless = true",
		"# 我的主题设置",
		"config_version = 12",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("saved config dropped %q\n--- got ---\n%s", want, got)
		}
	}
	if !strings.Contains(got, `theme = "light"`) {
		t.Errorf("edited setting not written\n--- got ---\n%s", got)
	}
	requireLinesSameExcept(t, userConfigWithForeignTables, got, `theme = "dark"`, `theme = "light"`)
}

// TestSavingUserConfigKeepsForeignTablesOnFallback covers the path taken when an
// edit cannot be expressed key by key: the whole render is written, the tables
// this build does not decode are carried over, and the prior bytes are kept.
func TestSavingUserConfigKeepsForeignTablesOnFallback(t *testing.T) {
	const body = "config_version = 12\nlanguage = \"en\"\n\n[checkpoints]\nretain_turns = 7\n"
	path := seedUserConfig(t, body)

	cfg := LoadForEdit(path)
	cfg.Language = "" // dropping a top-level key has no key-by-key form
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	if !strings.Contains(got, "[checkpoints]\nretain_turns = 7") {
		t.Errorf("fallback dropped a table it does not decode\n--- got ---\n%s", got)
	}
	backups, err := filepath.Glob(path + ".rewrite-*")
	if err != nil {
		t.Fatalf("glob backups: %v", err)
	}
	if len(backups) == 0 {
		t.Errorf("a whole-render save must keep the prior bytes beside the file")
	} else if prior := readUserConfig(t, backups[0]); prior != body {
		t.Errorf("backup is not the prior bytes:\n%s", prior)
	}
}

// TestSavingNewUserConfigRendersWholeTemplate covers a first save with no file
// to preserve.
func TestSavingNewUserConfigRendersWholeTemplate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	path := filepath.Join(home, "config.toml")

	cfg := Default()
	cfg.UI.Theme = "light"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	for _, want := range []string{"[ui]", `theme = "light"`, "[[providers]]"} {
		if !strings.Contains(got, want) {
			t.Errorf("new config missing %q\n--- got ---\n%s", want, got)
		}
	}
}

// TestSavingUserConfigAddingProviderKeepsExistingEntries covers an array of
// tables: the entries already in the file must survive the save.
func TestSavingUserConfigAddingProviderKeepsExistingEntries(t *testing.T) {
	const body = `config_version = 12

[[providers]]
name = "deepseek-flash"
kind = "openai"
base_url = "https://api.deepseek.com"

[checkpoints]
retain_turns = 7
`
	path := seedUserConfig(t, body)

	cfg := LoadForEdit(path)
	cfg.Providers = append(cfg.Providers, ProviderEntry{
		Name:    "local-ollama",
		Kind:    "openai",
		BaseURL: "http://127.0.0.1:11434/v1",
		Model:   "qwen3",
	})
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	// A replaced table is written from the render, whose keys are padded, so
	// assert on the entries rather than on one exact spacing.
	for _, want := range []string{`"deepseek-flash"`, `"local-ollama"`, "[checkpoints]\nretain_turns = 7"} {
		if !strings.Contains(got, want) {
			t.Errorf("saved config lost %q\n--- got ---\n%s", want, got)
		}
	}
}
