package config

import (
	"strings"
	"testing"
)

func TestAppliesOfficialDeepSeekV4ProPersona(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		entry *ProviderEntry
		want  bool
	}{
		{
			name:  "nil",
			entry: nil,
			want:  false,
		},
		{
			name: "official pro",
			entry: &ProviderEntry{
				Name:    "deepseek",
				BaseURL: "https://api.deepseek.com",
				Model:   "deepseek-v4-pro",
			},
			want: true,
		},
		{
			name: "official anthropic pro",
			entry: &ProviderEntry{
				Name:    "deepseek",
				Kind:    "anthropic",
				BaseURL: "https://api.deepseek.com/anthropic",
				Model:   "deepseek-v4-pro",
			},
			want: true,
		},
		{
			name: "official flash",
			entry: &ProviderEntry{
				Name:    "deepseek",
				BaseURL: "https://api.deepseek.com",
				Model:   "deepseek-v4-flash",
			},
			want: false,
		},
		{
			name: "third party pro name",
			entry: &ProviderEntry{
				Name:    "novita",
				BaseURL: "https://api.novita.ai/openai",
				Model:   "deepseek/deepseek-v4-pro",
			},
			want: false,
		},
		{
			name: "empty model on official host",
			entry: &ProviderEntry{
				Name:    "deepseek",
				BaseURL: "https://api.deepseek.com",
			},
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := AppliesOfficialDeepSeekV4ProPersona(tt.entry); got != tt.want {
				t.Fatalf("AppliesOfficialDeepSeekV4ProPersona() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestApplyOfficialDeepSeekV4ProPersonaPrependsOnce(t *testing.T) {
	t.Parallel()
	pro := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-pro"}
	got := ApplyOfficialDeepSeekV4ProPersona("You are Reasonix, a coding agent.", pro)
	want := OfficialDeepSeekV4ProPersona + "\n\nYou are Reasonix, a coding agent."
	if got != want {
		t.Fatalf("prepend = %q, want %q", got, want)
	}
	if again := ApplyOfficialDeepSeekV4ProPersona(got, pro); again != want {
		t.Fatalf("second apply duplicated persona:\n%s", again)
	}
}

func TestApplyOfficialDeepSeekV4ProPersonaStripsForOtherModels(t *testing.T) {
	t.Parallel()
	pro := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-pro"}
	flash := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-flash"}
	withPersona := ApplyOfficialDeepSeekV4ProPersona("BASE", pro)
	got := ApplyOfficialDeepSeekV4ProPersona(withPersona, flash)
	if got != "BASE" {
		t.Fatalf("flash should drop the official pro persona, got %q", got)
	}
}

func TestReasoningLanguageForEntryPinsOfficialProAutoToEnglish(t *testing.T) {
	t.Parallel()
	pro := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-pro"}
	flash := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-flash"}
	if got := ReasoningLanguageForEntry(pro, "auto"); got != "en" {
		t.Fatalf("official pro auto = %q, want en", got)
	}
	if got := ReasoningLanguageForEntry(pro, "zh"); got != "zh" {
		t.Fatalf("explicit zh must stay user-owned, got %q", got)
	}
	if got := ReasoningLanguageForEntry(pro, "off"); got != "off" {
		t.Fatalf("explicit off must not be rewritten to en, got %q", got)
	}
	if got := ReasoningLanguageForEntry(flash, "auto"); got != "auto" {
		t.Fatalf("flash auto = %q, want auto", got)
	}
}

func TestPersonaForReasoningDropsThinkingClauseOnlyForOff(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"auto", "zh", "en", ""} {
		if got := OfficialDeepSeekV4ProPersonaForReasoning(mode); got != OfficialDeepSeekV4ProPersona {
			t.Fatalf("mode %q persona = %q, want historical persona", mode, got)
		}
	}
	off := OfficialDeepSeekV4ProPersonaForReasoning("off")
	if off != OfficialDeepSeekV4ProPersonaCore {
		t.Fatalf("off persona = %q, want core sentence only", off)
	}
	if strings.Contains(off, "ENGLISH") || strings.Contains(off, "We need") {
		t.Fatalf("off persona kept thinking guidance: %q", off)
	}
}

func TestApplyPersonaForReasoningReplacesStaleShape(t *testing.T) {
	t.Parallel()
	pro := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-pro"}
	full := ApplyOfficialDeepSeekV4ProPersonaForReasoning("BASE", pro, "zh")
	if !strings.HasPrefix(full, OfficialDeepSeekV4ProPersona+"\n\n") {
		t.Fatalf("zh persona missing full form: %q", full)
	}
	// Switching to off at build time must not leave the old thinking clause or
	// stack a second persona sentence.
	off := ApplyOfficialDeepSeekV4ProPersonaForReasoning(full, pro, "off")
	if off != OfficialDeepSeekV4ProPersonaCore+"\n\nBASE" {
		t.Fatalf("off rebuild = %q, want core persona over BASE", off)
	}
	// And switching back restores exactly one full persona.
	back := ApplyOfficialDeepSeekV4ProPersonaForReasoning(off, pro, "auto")
	if back != OfficialDeepSeekV4ProPersona+"\n\nBASE" {
		t.Fatalf("auto rebuild = %q, want full persona over BASE", back)
	}
}

// A non-V4-Pro endpoint must keep the pre-off behaviour: only the full persona
// is stripped. A user prompt that happens to open with the same generic
// sentence is untouched.
func TestApplyPersonaForReasoningLeavesUserPromptOnOtherModels(t *testing.T) {
	t.Parallel()
	flash := &ProviderEntry{BaseURL: "https://api.deepseek.com", Model: "deepseek-v4-flash"}
	const userPrompt = OfficialDeepSeekV4ProPersonaCore + "\n\nMY CUSTOM PROMPT"
	for _, mode := range []string{"auto", "zh", "en", "off"} {
		if got := ApplyOfficialDeepSeekV4ProPersonaForReasoning(userPrompt, flash, mode); got != userPrompt {
			t.Fatalf("mode %q stripped a user-authored line: %q", mode, got)
		}
	}
}

func TestLanguagePolicyForReasoning(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"auto", "zh", "en", ""} {
		if got := LanguagePolicyForReasoning(mode); got != LanguagePolicy {
			t.Fatalf("mode %q policy = %q, want historical policy", mode, got)
		}
	}
	off := LanguagePolicyForReasoning("off")
	if strings.Contains(off, ReasoningLanguageGuidance) {
		t.Fatalf("off policy kept thinking guidance: %q", off)
	}
	if !strings.Contains(off, "Reply in the same language") || !strings.Contains(off, "never translate them") {
		t.Fatalf("off policy lost the reply-language contract: %q", off)
	}
}
