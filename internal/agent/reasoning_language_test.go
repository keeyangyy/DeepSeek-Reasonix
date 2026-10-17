package agent

import (
	"context"
	"strings"
	"testing"
)

func TestWithResponseLanguageOnlySkipsLeadingInjectedBlock(t *testing.T) {
	userMention := "explain why <response-language> appears in this file"
	got := WithResponseLanguage(userMention, "en")
	if !strings.HasPrefix(got, "<response-language>") || !strings.Contains(got, "use English") || !strings.HasSuffix(got, userMention) {
		t.Fatalf("WithResponseLanguage should prefix user-authored tag mentions, got %q", got)
	}

	alreadyPrefixed := ResponseLanguageBlock("en") + "\n\n" + userMention
	if got := WithResponseLanguage(alreadyPrefixed, "en"); got != alreadyPrefixed {
		t.Fatalf("WithResponseLanguage duplicated a leading injected block:\n got %q\nwant %q", got, alreadyPrefixed)
	}

	withLeadingMemory := "<memory-update>\nRemember this.\n</memory-update>\n\n" + alreadyPrefixed
	if got := WithResponseLanguage(withLeadingMemory, "en"); got != withLeadingMemory {
		t.Fatalf("WithResponseLanguage duplicated a response block after leading transient context:\n got %q\nwant %q", got, withLeadingMemory)
	}
}

func TestWithReasoningLanguageOnlySkipsLeadingInjectedBlock(t *testing.T) {
	userMention := "explain why <reasoning-language> appears in this file"
	got := WithReasoningLanguage(userMention, "zh")
	if !strings.HasPrefix(got, "<reasoning-language>") || !strings.Contains(got, "简体中文") || !strings.HasSuffix(got, userMention) {
		t.Fatalf("WithReasoningLanguage should prefix user-authored tag mentions, got %q", got)
	}

	alreadyPrefixed := ReasoningLanguageBlock("zh") + "\n\n" + userMention
	if got := WithReasoningLanguage(alreadyPrefixed, "zh"); got != alreadyPrefixed {
		t.Fatalf("WithReasoningLanguage duplicated a leading injected block:\n got %q\nwant %q", got, alreadyPrefixed)
	}

	withLeadingMemory := "<memory-update>\nRemember this.\n</memory-update>\n\n" + alreadyPrefixed
	if got := WithReasoningLanguage(withLeadingMemory, "zh"); got != withLeadingMemory {
		t.Fatalf("WithReasoningLanguage duplicated a reasoning block after leading transient context:\n got %q\nwant %q", got, withLeadingMemory)
	}
}

func TestReasoningLanguageBlockZhStaysImperative(t *testing.T) {
	// The imperative form measurably outperforms soft "偏好" phrasing on
	// Chinese prompts that embed English logs/code; keep it from regressing
	// back into a suggestion.
	block := ReasoningLanguageBlock("zh")
	for _, want := range []string{"必须使用简体中文", "整轮", "不覆盖用户对最终回答语言的明确要求"} {
		if !strings.Contains(block, want) {
			t.Fatalf("zh reasoning block lost required anchor %q:\n%s", want, block)
		}
	}
}

func TestWithReasoningLanguageAutoInfersFromSource(t *testing.T) {
	chinese := WithReasoningLanguage("解释 AuthHandler 的 panic", "auto")
	if !strings.HasPrefix(chinese, "<reasoning-language>") || !strings.Contains(chinese, "简体中文") {
		t.Fatalf("auto reasoning language should infer Chinese, got %q", chinese)
	}

	english := WithReasoningLanguage("explain this module", "auto")
	if english != "explain this module" {
		t.Fatalf("auto reasoning language should keep English prompts unwrapped, got %q", english)
	}

	short := WithReasoningLanguage("hi", "auto")
	if short != "hi" {
		t.Fatalf("short ambiguous auto prompt should not be wrapped, got %q", short)
	}
}

func TestWithReasoningLanguageAutoUsesRawSourceOverReferencedContext(t *testing.T) {
	expanded := "Referenced context:\n\n<file path=\"auth.go\">\npackage main\nfunc AuthHandler() error { return errors.New(\"not authorized\") }\n</file>\n\n解释 @auth.go 的报错"

	got := WithReasoningLanguageForSource(expanded, "auto", "解释 @auth.go 的报错")
	if !strings.HasPrefix(got, "<reasoning-language>") || !strings.Contains(got, "简体中文") {
		t.Fatalf("auto reasoning language should use raw source over referenced context, got %q", got)
	}
	if strings.Contains(got, "use English") {
		t.Fatalf("referenced English code should not make auto prefer English:\n%s", got)
	}
}

func TestWithReasoningLanguageOffInjectsNothing(t *testing.T) {
	// off must be a true no-op: the same Chinese prompt that auto wraps stays
	// byte-identical, and no substitute instruction is emitted.
	chinese := "解释 AuthHandler 的 panic"
	if got := WithReasoningLanguage(chinese, "off"); got != chinese {
		t.Fatalf("off reasoning language altered the prompt:\n got %q\nwant %q", got, chinese)
	}
	if block := ReasoningLanguageBlock("off"); block != "" {
		t.Fatalf("ReasoningLanguageBlock(off) = %q, want empty", block)
	}
	if resolved := ResolveReasoningLanguage("off", chinese); resolved != "off" {
		t.Fatalf("ResolveReasoningLanguage(off) = %q, want off", resolved)
	}
}

func TestWithReasoningLanguageOffLeavesExistingBlocksAlone(t *testing.T) {
	// Leading blocks produced by an older setting are historical content: off
	// must not strip or rewrite them, only stop adding new ones.
	alreadyPrefixed := ReasoningLanguageBlock("zh") + "\n\n解释这个模块"
	if got := WithReasoningLanguageForSource(alreadyPrefixed, "off", "解释这个模块"); got != alreadyPrefixed {
		t.Fatalf("off rewrote an existing leading block:\n got %q\nwant %q", got, alreadyPrefixed)
	}
}

func TestReasoningLanguageContextCarriesOff(t *testing.T) {
	ctx := WithReasoningLanguagePreference(context.TODO(), "OFF")
	if got := ReasoningLanguageFromContext(ctx); got != "off" {
		t.Fatalf("ReasoningLanguageFromContext = %q, want off", got)
	}
	// A live change back to auto must clear the stored off value.
	ctx = WithReasoningLanguagePreference(ctx, "auto")
	if got := ReasoningLanguageFromContext(ctx); got != "auto" {
		t.Fatalf("ReasoningLanguageFromContext = %q, want auto", got)
	}
}
