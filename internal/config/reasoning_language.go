package config

import (
	"fmt"
	"strings"
)

// ReasoningLanguage normalizes agent.reasoning_language. Empty means auto;
// "off" disables both the transient block and the stable prompt guidance.
func (c *Config) ReasoningLanguage() string {
	if c == nil {
		return "auto"
	}
	return NormalizeReasoningLanguage(c.Agent.ReasoningLanguage)
}

// NormalizeReasoningLanguage returns one of auto|zh|en|off.
func NormalizeReasoningLanguage(lang string) string {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "", "auto", "follow", "conversation", "detect", "default", "model", "model-default", "model_default", "provider":
		return "auto"
	case "zh", "cn", "chinese", "中文":
		return "zh"
	case "en", "english":
		return "en"
	case "off", "none", "disabled", "never":
		return "off"
	default:
		return "auto"
	}
}

// SetReasoningLanguage pins the visible-reasoning language. Empty/auto follows
// the conversation language; off injects no preference and drops the stable
// system-prompt guidance as well.
func (c *Config) SetReasoningLanguage(lang string) error {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "", "auto", "follow", "conversation", "detect", "default", "model", "model-default", "model_default", "provider":
		c.Agent.ReasoningLanguage = ""
	case "zh", "cn", "chinese", "中文":
		c.Agent.ReasoningLanguage = "zh"
	case "en", "english":
		c.Agent.ReasoningLanguage = "en"
	case "off", "none", "disabled", "never":
		c.Agent.ReasoningLanguage = "off"
	default:
		return fmt.Errorf("reasoning language %q: must be auto|zh|en|off", lang)
	}
	return nil
}

// ReplyLanguagePolicyWithoutGuidance keeps the final-answer language contract
// identical to LanguagePolicy minus the thinking sentence.
const ReplyLanguagePolicyWithoutGuidance = `Reply in the same language the user is using in their most recent message: ` +
	`if they write in Chinese answer in Chinese, in English answer in English, and switch ` +
	`whenever they switch. Always keep code, identifiers, file paths, shell commands, and technical terms ` +
	`in their original form — never translate them.`

// ReasoningLanguageGuidance is the only LanguagePolicy sentence that steers
// visible thinking. It is omitted when agent.reasoning_language is "off".
const ReasoningLanguageGuidance = `Let this also guide the language you think in.`

// LanguagePolicy is the auto fallback appended to the system prompt. It stays
// byte-identical to the pre-off wording, so existing sessions keep their
// cached prefix unless the user explicitly selects off.
const LanguagePolicy = `Reply in the same language the user is using in their most recent message: ` +
	`if they write in Chinese answer in Chinese, in English answer in English, and switch ` +
	`whenever they switch. ` + ReasoningLanguageGuidance + ` Always keep code, ` +
	`identifiers, file paths, shell commands, and technical terms in their original form — never translate them.`

// LanguagePolicyForReasoning returns the core language policy for a mode. Only
// off drops the thinking sentence; every other mode returns LanguagePolicy.
func LanguagePolicyForReasoning(lang string) string {
	if NormalizeReasoningLanguage(lang) == "off" {
		return ReplyLanguagePolicyWithoutGuidance
	}
	return LanguagePolicy
}
