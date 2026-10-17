package control

import "testing"

func TestComposeReasoningLanguageOffInjectsNothing(t *testing.T) {
	// The same Chinese prompt that auto anchors must stay untouched under off,
	// for both real turns and synthetic host turns.
	c := New(Options{ReasoningLanguage: "off"})
	const prompt = "解释 AuthHandler 的 panic"
	if got := c.Compose(prompt); got != prompt {
		t.Fatalf("off Compose = %q, want %q", got, prompt)
	}
	if got := c.ComposeSynthetic(prompt); got != prompt {
		t.Fatalf("off ComposeSynthetic = %q, want %q", got, prompt)
	}
}
