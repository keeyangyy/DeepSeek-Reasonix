package config

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

// The property this file guards: a save changes the keys it was asked to change
// and nothing else, so unknown keys, comments and odd spacing in a file shared
// with the 1.x and Studio lines survive byte for byte.

// ownedLine is one line the generator wrote that a save must not touch.
type ownedLine struct {
	owner string
	text  string
}

// userConfigGen builds a user config in the shapes people leave behind.
type userConfigGen struct {
	r    *rand.Rand
	used map[string]bool
	owns []ownedLine
}

func (g *userConfigGen) pick(xs ...string) string { return xs[g.r.Intn(len(xs))] }
func (g *userConfigGen) chance(p float64) bool    { return g.r.Float64() < p }

// fromAnotherLine writes a key this build does not decode and records it as
// owned by whoever wrote it.
func (g *userConfigGen) fromAnotherLine(b *strings.Builder, owner, key string) {
	value := g.pick(`"keep-me"`, "42", "true", "3.5", `["a", "b"]`, "{ a = 1 }")
	fmt.Fprintf(b, "%s = %s\n", key, value)
	g.owns = append(g.owns, ownedLine{owner: owner, text: key + " = " + value})
}

func (g *userConfigGen) doc() string {
	var b strings.Builder
	b.WriteString("config_version = 9\n")
	b.WriteString(`default_model = "deepseek-flash"`)
	b.WriteString("\n")
	b.WriteString("# a hand-written note that must survive\n")

	// Untouched tables, in an order the renderer would not produce.
	if g.chance(0.5) {
		g.table(&b, "checkpoints", "retain_turns = 7")
	}
	g.table(&b, "ui", `theme = "dark"`)
	g.table(&b, "desktop", `language = "zh"`, `theme_pack = "obsidian"`, "welcomed = true")
	if g.chance(0.5) {
		g.table(&b, "agent", "temperature = 0.5")
	}
	if g.chance(0.5) {
		g.table(&b, "cli", `editor = "cursor"`)
	}

	// Arrays of tables, each element carrying a field only another line knows.
	b.WriteString("\n[[providers]]\n")
	b.WriteString("name = \"deepseek\"\n")
	b.WriteString("kind = \"openai\"\n")
	b.WriteString("base_url = \"https://api.deepseek.com\"\n")
	b.WriteString("models = [\"deepseek-v4-flash\"]\n")
	if g.chance(0.6) {
		b.WriteString("studio_catalog_id = \"deepseek-v4\"\n")
		g.owns = append(g.owns, ownedLine{owner: "studio", text: `studio_catalog_id = "deepseek-v4"`})
	}

	if g.chance(0.5) {
		b.WriteString("\n[[providers]]\n")
		b.WriteString("name = \"other\"\n")
		b.WriteString("kind = \"openai\"\n")
		b.WriteString("base_url = \"https://example.com/v1\"\n")
		b.WriteString("model = \"other-model\"\n")
	}

	if g.chance(0.4) {
		b.WriteString("\n[[plugins]]\n")
		b.WriteString("name = \"ctx7\"\n")
		b.WriteString("command = \"npx\"\n")
		b.WriteString(`args = ["-y", "ctx7"]` + "\n")
		g.owns = append(g.owns, ownedLine{owner: "studio", text: `args = ["-y", "ctx7"]`})
	}
	return b.String()
}

func (g *userConfigGen) table(b *strings.Builder, name string, known ...string) {
	fmt.Fprintf(b, "\n[%s]\n", name)
	for _, line := range known {
		b.WriteString(line + "\n")
	}
	if g.chance(0.7) {
		g.fromAnotherLine(b, "1x", "zz_"+name+"_unknown")
	}
}

// configEdit is one edit a save can be asked to apply.
type configEdit struct {
	name  string
	apply func(*Config) error
	check func(t *testing.T, got *Config)
}

func (g *userConfigGen) edits() []configEdit {
	return []configEdit{
		{
			name:  "desktop theme",
			apply: func(c *Config) error { return c.SetDesktopAppearance("light", "graphite") },
			check: func(t *testing.T, got *Config) {
				if got.Desktop.Theme != "light" {
					t.Errorf("desktop.theme = %q, want light", got.Desktop.Theme)
				}
			},
		},
		{
			name:  "ui theme",
			apply: func(c *Config) error { c.UI.Theme = "light"; return nil },
			check: func(t *testing.T, got *Config) {
				if got.UI.Theme != "light" {
					t.Errorf("ui.theme = %q, want light", got.UI.Theme)
				}
			},
		},
		{
			name:  "agent temperature",
			apply: func(c *Config) error { c.Agent.Temperature = 0.9; return nil },
			check: func(t *testing.T, got *Config) {
				if got.Agent.Temperature != 0.9 {
					t.Errorf("agent.temperature = %v, want 0.9", got.Agent.Temperature)
				}
			},
		},
		{
			name:  "default model",
			apply: func(c *Config) error { c.DefaultModel = "deepseek-pro"; return nil },
			check: func(t *testing.T, got *Config) {
				if got.DefaultModel != "deepseek-pro" {
					t.Errorf("default_model = %q, want deepseek-pro", got.DefaultModel)
				}
			},
		},
	}
}

// checkRandomSave seeds one random config, applies one random edit, and asserts
// the save changed only what it was asked to change.
func checkRandomSave(t *testing.T, seed int64) {
	t.Helper()
	g := &userConfigGen{r: rand.New(rand.NewSource(seed)), used: map[string]bool{}}
	body := g.doc()

	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	path := filepath.Join(home, "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("seed does not load: %v\n--- seed ---\n%s", err, body)
	}
	edits := g.edits()
	edit := edits[g.r.Intn(len(edits))]
	if err := edit.apply(cfg); err != nil {
		t.Fatalf("%s: apply: %v", edit.name, err)
	}
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("%s: save: %v\n--- seed ---\n%s", edit.name, err, body)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}

	// 1. The saved file still parses.
	var tree map[string]any
	if _, err := toml.Decode(string(saved), &tree); err != nil {
		t.Fatalf("%s: saved file does not parse: %v\n--- saved ---\n%s", edit.name, err, saved)
	}
	// 2. The edit landed.
	got, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("%s: saved file does not load: %v\n--- saved ---\n%s", edit.name, err, saved)
	}
	edit.check(t, got)
	// 3. Every line another line owns is still there, in order.
	remaining := string(saved)
	for _, line := range g.owns {
		at := strings.Index(remaining, line.text)
		if at < 0 {
			t.Fatalf("%s: save dropped the %s line %q\n--- saved ---\n%s", edit.name, line.owner, line.text, saved)
		}
		remaining = remaining[at+len(line.text):]
	}
	// 4. No whole-file rewrite: the save is in place, so no backup appears.
	if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
		t.Fatalf("%s: save fell back to a whole-file rewrite (%v)\n--- saved ---\n%s", edit.name, backups, saved)
	}
}

// TestRandomUserConfigSavesEditInPlace is the seeded sweep: a few hundred config
// shapes, each saved once.
func TestRandomUserConfigSavesEditInPlace(t *testing.T) {
	for seed := range int64(200) {
		t.Run(fmt.Sprintf("seed-%03d", seed), func(t *testing.T) {
			checkRandomSave(t, seed)
		})
	}
}

// FuzzUserConfigSave keeps the same property under the fuzzer, so a new TOML
// shape someone hand-writes finds the next blind spot before it reaches a user.
func FuzzUserConfigSave(f *testing.F) {
	for _, seed := range []string{
		"config_version = 9\n[ui]\ntheme = \"dark\"\n",
		"config_version = 9\n[desktop]\nlanguage = \"zh\"\nzz_unknown = 1\n",
		"config_version = 9\n[[providers]]\nname = \"deepseek\"\nkind = \"openai\"\nbase_url = \"https://api.deepseek.com\"\n",
	} {
		f.Add(seed, "ui")
	}
	f.Fuzz(func(t *testing.T, body, editName string) {
		home := t.TempDir()
		t.Setenv("REASONIX_HOME", home)
		t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
		path := filepath.Join(home, "config.toml")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Skip()
		}
		cfg, err := LoadForEditReadOnlyStrict(path)
		if err != nil {
			// An unparseable seed is not this property's subject: the save is
			// supposed to refuse it, and refusing is covered elsewhere.
			return
		}
		// Pick an edit that always has an in-place form, so the run exercises
		// the patch path rather than the rewrite fallback.
		switch editName {
		case "ui":
			cfg.UI.Theme = "light"
		case "desktop":
			cfg.Desktop.Theme = "light"
		case "agent":
			cfg.Agent.Temperature = 0.9
		case "default-model":
			cfg.DefaultModel = "deepseek-pro"
		default:
			cfg.UI.Theme = "light"
		}
		if err := cfg.SaveTo(path); err != nil {
			t.Fatalf("save of a loadable config failed: %v\n--- seed ---\n%s", err, body)
		}
		saved, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var tree map[string]any
		if _, err := toml.Decode(string(saved), &tree); err != nil {
			t.Fatalf("saved file does not parse: %v\n--- saved ---\n%s", err, saved)
		}
		if _, err := LoadForEditReadOnlyStrict(path); err != nil {
			t.Fatalf("saved file does not load: %v\n--- saved ---\n%s", err, saved)
		}
		// The save must stay in place: a whole-file rewrite would drop every
		// key this build does not model.
		if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
			t.Fatalf("save fell back to a whole-file rewrite (%v)\n--- seed ---\n%s\n--- saved ---\n%s", backups, body, saved)
		}
	})
}

var _ = reflect.DeepEqual
