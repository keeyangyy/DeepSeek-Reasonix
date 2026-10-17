package config

import "strings"

// OfficialDeepSeekV4ProPersonaCore is the stable persona sentence. It stays in
// the system prompt even when thinking-language guidance is disabled.
const OfficialDeepSeekV4ProPersonaCore = `You are a helpful software engineer assistant.`

// OfficialDeepSeekV4ProThinking is the thinking-language clause of the persona.
// It is dropped when agent.reasoning_language is "off".
const OfficialDeepSeekV4ProThinking = ` when you thought, thought in ENGLISH, start with "We need.."`

// OfficialDeepSeekV4ProPersona is prepended to the cache-stable system prompt
// for official DeepSeek-V4-Pro. That model's agent post-training is peaked on
// this first-line persona and English "We need" thinking.
const OfficialDeepSeekV4ProPersona = OfficialDeepSeekV4ProPersonaCore + OfficialDeepSeekV4ProThinking

// OfficialDeepSeekV4ProPersonaForReasoning returns the persona paragraph for a
// reasoning-language mode. Only off drops the thinking clause; auto/zh/en keep
// the historical persona byte-for-byte.
func OfficialDeepSeekV4ProPersonaForReasoning(lang string) string {
	if NormalizeReasoningLanguage(lang) == "off" {
		return OfficialDeepSeekV4ProPersonaCore
	}
	return OfficialDeepSeekV4ProPersona
}

// AppliesOfficialDeepSeekV4ProPersona reports whether the resolved official
// DeepSeek endpoint is serving V4 Pro. Third-party hosts are excluded even
// when they reuse the same model id.
func AppliesOfficialDeepSeekV4ProPersona(e *ProviderEntry) bool {
	if e == nil || officialProviderKind(e) != "deepseek" {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(e.Model), "deepseek-v4-pro")
}

// ApplyOfficialDeepSeekV4ProPersona keeps the persona as the first system-prompt
// paragraph for official V4 Pro and strips it when the session is not that model.
func ApplyOfficialDeepSeekV4ProPersona(prompt string, e *ProviderEntry) string {
	return ApplyOfficialDeepSeekV4ProPersonaForReasoning(prompt, e, "auto")
}

// ApplyOfficialDeepSeekV4ProPersonaForReasoning is ApplyOfficialDeepSeekV4ProPersona
// with an explicit reasoning-language mode. off keeps the persona sentence but
// removes its thinking-language clause.
func ApplyOfficialDeepSeekV4ProPersonaForReasoning(prompt string, e *ProviderEntry, lang string) string {
	// Core form only ever appears for official V4 Pro; other endpoints keep the
	// pre-off behaviour so a user prompt starting with the same sentence survives.
	allowCoreForm := AppliesOfficialDeepSeekV4ProPersona(e)
	prompt = stripOfficialDeepSeekV4ProPersona(prompt, allowCoreForm)
	if !AppliesOfficialDeepSeekV4ProPersona(e) {
		return prompt
	}
	persona := OfficialDeepSeekV4ProPersonaForReasoning(lang)
	if strings.TrimSpace(prompt) == "" {
		return persona
	}
	return persona + "\n\n" + prompt
}

// stripOfficialDeepSeekV4ProPersona removes any leading persona paragraph, in
// either the full or the thinking-free form. Repeated stripping keeps a stale
// persona from stacking when the mode changes between builds.
//
// allowCoreForm is only set when the thinking-free paragraph could have been
// produced by this build: that shape is nothing but a generic "you are a
// helpful software engineer assistant" sentence, so stripping it from an
// unrelated custom prompt would delete user text.
func stripOfficialDeepSeekV4ProPersona(prompt string, allowCoreForm bool) string {
	for {
		next, stripped := stripOneOfficialDeepSeekV4ProPersona(prompt, allowCoreForm)
		if !stripped {
			return prompt
		}
		prompt = next
	}
}

func stripOneOfficialDeepSeekV4ProPersona(prompt string, allowCoreForm bool) (string, bool) {
	personas := []string{OfficialDeepSeekV4ProPersona}
	if allowCoreForm {
		// Try the full form first: its first sentence is the core form, so
		// matching the core form first would leave a dangling thinking clause.
		personas = append(personas, OfficialDeepSeekV4ProPersonaCore)
	}
	for _, persona := range personas {
		switch {
		case strings.HasPrefix(prompt, persona+"\n\n"):
			return strings.TrimPrefix(prompt, persona+"\n\n"), true
		case strings.HasPrefix(prompt, persona+"\n"):
			return strings.TrimPrefix(prompt, persona+"\n"), true
		case prompt == persona:
			return "", true
		}
	}
	return prompt, false
}

// ReasoningLanguageForEntry pins official V4 Pro auto mode to English so the
// per-turn Chinese auto-inference cannot override the persona. Explicit zh/en
// and off stay user-owned: off must not be rewritten into an injection mode.
func ReasoningLanguageForEntry(e *ProviderEntry, configured string) string {
	if AppliesOfficialDeepSeekV4ProPersona(e) && NormalizeReasoningLanguage(configured) == "auto" {
		return "en"
	}
	return configured
}
