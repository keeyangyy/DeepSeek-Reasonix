package agent

import (
	"os"
	"strings"
	"testing"
)

// Providers return a blank reasoning block on some tool-call turns — real
// sessions carry `reasoning_content` values that are a single space, 559 of
// them against 48 with content in one 820-row transcript. Persisting that
// whitespace is what made the desktop header count "1 thought" over an empty
// body, so the stored value is normalized at the single assistant exit point.
func TestAssistantMessageNormalizesBlankReasoning(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"single space", " ", ""},
		{"several spaces", "   ", ""},
		{"tabs and newlines", "\t\n\r\n  ", ""},
		{"already empty", "", ""},
		{"real content", "need to read the file", "need to read the file"},
		{"content with padding", "  kept thinking  ", "  kept thinking  "},
		{"content on later lines", "\n\nsecond line", "\n\nsecond line"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := streamedTurn{reasoning: tc.in}.assistantMessage().ReasoningContent
			if got != tc.want {
				t.Fatalf("reasoning = %q, want %q", got, tc.want)
			}
		})
	}
}

// Normalization must not disturb the other fields the exit point fills in.
func TestAssistantMessageNormalizationKeepsContentAndCalls(t *testing.T) {
	turn := streamedTurn{
		text:      "visible answer",
		reasoning: "  ",
	}
	msg := turn.assistantMessage()
	if msg.ReasoningContent != "" {
		t.Fatalf("reasoning = %q, want empty", msg.ReasoningContent)
	}
	if msg.Content != "visible answer" {
		t.Fatalf("content = %q, want the visible answer", msg.Content)
	}
}

// The commit boundary writes the assistant turn itself rather than going through
// assistantMessage, so both paths must normalize. A guard here keeps a future
// refactor from fixing one and silently leaving the other raw.
func TestCommitBoundaryNormalizesBlankReasoning(t *testing.T) {
	src, err := os.ReadFile("run_loop.go")
	if err != nil {
		t.Fatalf("read run_loop.go: %v", err)
	}
	text := string(src)
	if strings.Contains(text, "ReasoningContent:   reasoning,") {
		t.Fatal("commit boundary still stores raw reasoning; use normalizeReasoning")
	}
	if !strings.Contains(text, "ReasoningContent:   normalizeReasoning(reasoning),") {
		t.Fatal("commit boundary no longer routes reasoning through normalizeReasoning")
	}
}
