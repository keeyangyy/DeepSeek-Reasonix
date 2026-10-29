package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// legacyDesktopKeys are decoded for compatibility but never rendered, so a save
// that rewrites the whole [desktop] table is expected to drop them.
var legacyDesktopKeys = map[string]bool{"update_channel": true}

// TestEveryDesktopKeyIsRendered guards the failure mode where a desktop setting
// is writable but missing from the render: the incremental save then has no line
// to patch, silently deletes the key, and the setting never reaches disk.
func TestEveryDesktopKeyIsRendered(t *testing.T) {
	cfg := Default()
	fillDesktopForRenderTest(&cfg.Desktop)
	cfg.Desktop.ConversationWidth = "full"
	cfg.Desktop.SessionExperience = "deep"
	rendered := RenderTOMLForScope(cfg, RenderScopeUser)
	typ := reflect.TypeOf(cfg.Desktop)
	for i := 0; i < typ.NumField(); i++ {
		key := strings.Split(typ.Field(i).Tag.Get("toml"), ",")[0]
		if key == "" || legacyDesktopKeys[key] {
			continue
		}
		if !strings.Contains(rendered, key+" = ") && !strings.Contains(rendered, "."+key+"]]") {
			t.Errorf("[desktop] key %q is never rendered; a save would drop it", key)
		}
	}
}

// fillDesktopForRenderTest gives every field a non-zero value so optional keys
// are rendered too; only the enumerations the renderer gates on are pinned.
func fillDesktopForRenderTest(d *DesktopConfig) {
	v := reflect.ValueOf(d).Elem()
	for i := 0; i < v.NumField(); i++ {
		f := v.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString("x")
		case reflect.Bool:
			f.SetBool(true)
		case reflect.Slice:
			f.Set(reflect.MakeSlice(f.Type(), 1, 1))
		case reflect.Ptr:
			if f.Type().Elem().Kind() == reflect.Bool {
				on := true
				f.Set(reflect.ValueOf(&on))
			}
		}
	}
}

// TestUpdateSourceSurvivesUserConfigSave covers the whole desktop write path:
// an existing file owned by another line, the incremental patch, and the reload.
func TestUpdateSourceSurvivesUserConfigSave(t *testing.T) {
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	path := UserConfigPath()
	if path == "" {
		t.Fatal("user config path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := "[studio]\nunknown_key = \"keep\"\n\n[desktop]\ntheme = \"dark\"\n"
	if err := os.WriteFile(path, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.SetUpdateSourceEnabled(false)
	cfg.SetUpdateMirrors([]UpdateMirrorConfig{
		{URL: "https://gh-proxy.com"},
		{URL: "https://ghfast.top", Disabled: true},
	})
	if err := cfg.SaveTo(path); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "unknown_key") {
		t.Fatalf("save dropped the other line's key:\n%s", raw)
	}

	got, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.UpdateSourceMirrorsEnabled() {
		t.Error("update_source_enabled came back on after save")
	}
	if len(got.Desktop.UpdateMirrors) != 2 {
		t.Fatalf("mirrors after reload = %+v, want 2 entries", got.Desktop.UpdateMirrors)
	}
	if !got.Desktop.UpdateMirrors[1].Disabled {
		t.Error("disabled mirror lost its flag after save")
	}
	if got.Desktop.UpdateMirrors[0].URL != "https://gh-proxy.com" {
		t.Errorf("first mirror after reload = %q", got.Desktop.UpdateMirrors[0].URL)
	}
}
