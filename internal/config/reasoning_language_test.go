package config

import "testing"

func TestSetReasoningLanguageOff(t *testing.T) {
	c := Default()
	if err := c.SetReasoningLanguage("off"); err != nil {
		t.Fatalf("SetReasoningLanguage off: %v", err)
	}
	if c.Agent.ReasoningLanguage != "off" || c.ReasoningLanguage() != "off" {
		t.Fatalf("reasoning language = %q/%q, want off", c.Agent.ReasoningLanguage, c.ReasoningLanguage())
	}
	// off is a persisted value, not an alias for auto: switching back to auto
	// must clear it rather than leaving stale state behind.
	if err := c.SetReasoningLanguage("auto"); err != nil {
		t.Fatalf("SetReasoningLanguage auto: %v", err)
	}
	if c.Agent.ReasoningLanguage != "" || c.ReasoningLanguage() != "auto" {
		t.Fatalf("reasoning language = %q/%q, want empty/auto", c.Agent.ReasoningLanguage, c.ReasoningLanguage())
	}
}

func TestNormalizeReasoningLanguageOffAliases(t *testing.T) {
	for _, in := range []string{"off", "OFF", " none ", "disabled", "never"} {
		if got := NormalizeReasoningLanguage(in); got != "off" {
			t.Fatalf("NormalizeReasoningLanguage(%q) = %q, want off", in, got)
		}
	}
	// Unknown legacy values must keep falling back to auto.
	for _, in := range []string{"", "auto", "default", "model", "klingon"} {
		if got := NormalizeReasoningLanguage(in); got != "auto" {
			t.Fatalf("NormalizeReasoningLanguage(%q) = %q, want auto", in, got)
		}
	}
}
