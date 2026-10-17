package boot

import (
	"context"
	"strings"
	"testing"

	"reasonix/internal/config"
)

func TestBuildOmitsThinkingGuidanceWhenReasoningLanguageOff(t *testing.T) {
	dir := robustTempDir(t)
	t.Chdir(dir)
	writeFile(t, dir, "reasonix.toml", `
default_model = "test-model"

[agent]
system_prompt = "BASE"
reasoning_language = "off"

[[providers]]
name = "test-model"
kind = "openai"
base_url = "https://example.invalid"
model = "x"
api_key_env = "REASONIX_TEST_KEY_UNSET"
`)

	ctrl, err := Build(context.Background(), Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	defer ctrl.Close()

	sys := systemMessage(ctrl.History())
	if strings.Contains(sys, config.ReasoningLanguageGuidance) {
		t.Fatalf("off must drop thinking-language guidance:\n%s", sys)
	}
	for _, want := range []string{
		"Reply in the same language",
		"never translate them",
		"User-owned choices",
	} {
		if !strings.Contains(sys, want) {
			t.Fatalf("off dropped unrelated policy %q:\n%s", want, sys)
		}
	}
}

func TestBuildKeepsThinkingGuidanceForZhAndEn(t *testing.T) {
	for _, mode := range []string{"zh", "en"} {
		t.Run(mode, func(t *testing.T) {
			dir := robustTempDir(t)
			t.Chdir(dir)
			writeFile(t, dir, "reasonix.toml", `
default_model = "test-model"

[agent]
system_prompt = "BASE"
reasoning_language = "`+mode+`"

[[providers]]
name = "test-model"
kind = "openai"
base_url = "https://example.invalid"
model = "x"
api_key_env = "REASONIX_TEST_KEY_UNSET"
`)

			ctrl, err := Build(context.Background(), Options{})
			if err != nil {
				t.Fatalf("Build: %v", err)
			}
			defer ctrl.Close()

			sys := systemMessage(ctrl.History())
			if !strings.Contains(sys, config.LanguagePolicy) {
				t.Fatalf("%s must keep the historical language policy:\n%s", mode, sys)
			}
		})
	}
}
