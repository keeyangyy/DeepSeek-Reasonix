package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"reasonix/internal/config"
)

// sharedConfigForDesktop is a user config shared with the Studio build: Studio
// only fields, hand-written keys, array-of-tables elements with foreign fields,
// an MCP command table this build does not decode, and a config version ahead
// of it. Switching one desktop preference must leave all of it in place.
const sharedConfigForDesktop = `config_version = 12
default_model = "deepseek-flash"
language = "zh"

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

[cli]
update_channel = "preview"
editor = "cursor"

[[providers]]
name = "deepseek"
kind = "openai"
base_url = "https://api.deepseek.com"
models = ["deepseek-v4-flash"]
studio_catalog_id = "deepseek-v4"

[[plugins]]
name = "ctx7"
command = "npx"
args = ["-y", "ctx7"]
studio_plugin_key = "keep-me"

[mcp_servers."ctx7"]
command = "npx"
studio_mcp_key = "keep-me"

[checkpoints]
retain_turns = 7
`

func seedDesktopUserConfig(t *testing.T, body string) string {
	t.Helper()
	path := config.UserConfigPath()
	if path == "" {
		t.Fatal("UserConfigPath is empty inside the isolated home")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readDesktopConfig(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func requireDesktopConfigKept(t *testing.T, got string) {
	t.Helper()
	for _, want := range []string{
		"theme_pack", "welcomed", "surface_slots", `editor = "code"`, "handwritten_desktop_key",
		"unknown_agent_key", "editor = \"cursor\"",
		"studio_catalog_id", "studio_plugin_key", "studio_mcp_key",
		"[checkpoints]", "retain_turns = 7",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("desktop save dropped %q\n--- got ---\n%s", want, got)
		}
	}
	if backups, _ := filepath.Glob(config.UserConfigPath() + ".rewrite-*"); len(backups) != 0 {
		t.Errorf("desktop save rewrote the whole file: %v", backups)
	}
}

// TestSetDesktopLanguageTouchesOnlyTheLanguageFields is the desktop-level
// regression test for the reported bug.
func TestSetDesktopLanguageTouchesOnlyTheLanguageFields(t *testing.T) {
	isolateDesktopUserDirs(t)
	projectRoot := t.TempDir()
	path := seedDesktopUserConfig(t, sharedConfigForDesktop)

	app := NewApp()
	app.tabs = map[string]*WorkspaceTab{
		"user": {ID: "user", Scope: "global", WorkspaceRoot: projectRoot, Ready: true, disabledMCP: map[string]ServerView{}},
	}
	app.activeTabID = "user"

	if err := app.SetDesktopLanguage("en"); err != nil {
		t.Fatalf("SetDesktopLanguage: %v", err)
	}

	got := readDesktopConfig(t, path)
	requireDesktopConfigKept(t, got)
	if !strings.Contains(got, `language = "en"`) {
		t.Errorf("desktop language not persisted\n--- got ---\n%s", got)
	}

	reloaded, err := config.LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("reload after language switch: %v", err)
	}
	if reloaded.DesktopLanguage() != "en" || reloaded.Language != "en" {
		t.Errorf("reloaded language = desktop:%q response:%q, want en/en", reloaded.DesktopLanguage(), reloaded.Language)
	}
	if reloaded.Desktop.Theme != "light" || !strings.Contains(got, "handwritten_desktop_key") {
		t.Errorf("unrelated desktop settings changed")
	}
}

// TestSetDesktopLanguageRepeatedSwitchesSurviveReload covers en -> auto -> zh
// and a reload after each switch. The auto step is the one that used to rewrite
// the file.
func TestSetDesktopLanguageRepeatedSwitchesSurviveReload(t *testing.T) {
	isolateDesktopUserDirs(t)
	path := seedDesktopUserConfig(t, sharedConfigForDesktop)

	app := NewApp()
	app.tabs = map[string]*WorkspaceTab{
		"user": {ID: "user", Scope: "global", Ready: true, disabledMCP: map[string]ServerView{}},
	}
	app.activeTabID = "user"

	for _, lang := range []string{"en", "auto", "zh", "en"} {
		if err := app.SetDesktopLanguage(lang); err != nil {
			t.Fatalf("SetDesktopLanguage(%q): %v", lang, err)
		}
		got := readDesktopConfig(t, path)
		requireDesktopConfigKept(t, got)
		reloaded, err := config.LoadForEditReadOnlyStrict(path)
		if err != nil {
			t.Fatalf("reload after %q: %v", lang, err)
		}
		want := lang
		if lang == "auto" {
			want = ""
		}
		if gotLang := reloaded.DesktopLanguage(); gotLang != want {
			t.Fatalf("after %q desktop language = %q, want %q", lang, gotLang, want)
		}
	}
}

// TestDesktopSettersConcurrentlyKeepEveryField drives the language setter and
// another config-only setter at the same time, which is the shape of a user
// changing a preference while the app persists another one.
func TestDesktopSettersConcurrentlyKeepEveryField(t *testing.T) {
	isolateDesktopUserDirs(t)
	path := seedDesktopUserConfig(t, sharedConfigForDesktop)

	app := NewApp()
	app.tabs = map[string]*WorkspaceTab{
		"user": {ID: "user", Scope: "global", Ready: true, disabledMCP: map[string]ServerView{}},
	}
	app.activeTabID = "user"

	const rounds = 25
	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []error
	record := func(err error) {
		if err == nil {
			return
		}
		mu.Lock()
		errs = append(errs, err)
		mu.Unlock()
	}

	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := range rounds {
			lang := "en"
			if i%2 == 1 {
				lang = "zh"
			}
			record(app.SetDesktopLanguage(lang))
		}
	}()
	go func() {
		defer wg.Done()
		for i := range rounds {
			style := "text"
			if i%2 == 1 {
				style = "icon"
			}
			record(app.SetStatusBarStyle(style))
		}
	}()
	wg.Wait()
	for _, err := range errs {
		t.Errorf("concurrent setter failed: %v", err)
	}

	got := readDesktopConfig(t, path)
	requireDesktopConfigKept(t, got)
	reloaded, err := config.LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("reload after concurrent setters: %v", err)
	}
	if reloaded.Desktop.StatusBarStyle != "icon" && reloaded.Desktop.StatusBarStyle != "text" {
		t.Errorf("status bar style lost: %q", reloaded.Desktop.StatusBarStyle)
	}
	if reloaded.DesktopLanguage() != "en" && reloaded.DesktopLanguage() != "zh" {
		t.Errorf("desktop language lost: %q", reloaded.DesktopLanguage())
	}
}

// TestSetDesktopLanguageReportsFailureAndLeavesTheFile covers the rollback
// requirement: when the existing file cannot be edited safely, the setter
// returns the error and the bytes on disk are untouched.
func TestSetDesktopLanguageReportsFailureAndLeavesTheFile(t *testing.T) {
	isolateDesktopUserDirs(t)
	// A value of the wrong type: this build cannot decode the file, so it must
	// refuse to write rather than replace it with a rendered template.
	const broken = `config_version = 12
language = "zh"

[desktop]
language = "zh"
theme_pack = "obsidian"

[agent]
temperature = "hot"

[[providers]]
name = "deepseek"
kind = "openai"
base_url = "https://api.deepseek.com"
studio_catalog_id = "deepseek-v4"
`
	path := seedDesktopUserConfig(t, broken)

	app := NewApp()
	app.tabs = map[string]*WorkspaceTab{
		"user": {ID: "user", Scope: "global", Ready: true, disabledMCP: map[string]ServerView{}},
	}
	app.activeTabID = "user"

	err := app.SetDesktopLanguage("en")
	if err == nil {
		t.Fatalf("SetDesktopLanguage accepted an unreadable config\n--- got ---\n%s", readDesktopConfig(t, path))
	}
	if got := readDesktopConfig(t, path); got != broken {
		t.Fatalf("failed save modified the file\n--- got ---\n%s", got)
	}
	if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
		t.Errorf("failed save left a rewrite backup: %v", backups)
	}
}
