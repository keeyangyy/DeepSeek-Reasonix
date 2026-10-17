package cli

import (
	"strings"
	"testing"

	"reasonix/internal/config"
)

func TestConfigReasoningLanguageCommandWritesOff(t *testing.T) {
	isolateCLIConfigHome(t)

	out := captureStdout(t, func() {
		if rc := Run([]string{"config", "reasoning-language", "off"}, "test-version"); rc != 0 {
			t.Fatalf("config reasoning-language off rc = %d, want 0", rc)
		}
	})
	if !strings.Contains(out, `reasoning_language = "off"`) {
		t.Fatalf("config reasoning-language off output = %q", out)
	}
	cfg := config.LoadForEdit(config.UserConfigPath())
	if cfg.Agent.ReasoningLanguage != "off" || cfg.ReasoningLanguage() != "off" {
		t.Fatalf("saved reasoning_language = %q/%q, want off", cfg.Agent.ReasoningLanguage, cfg.ReasoningLanguage())
	}
}
