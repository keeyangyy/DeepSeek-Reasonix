package boot

import "reasonix/internal/config"

// appendCorePolicies appends the host-owned policies to the system prompt.
// reasoningLanguage only affects the language policy: "off" drops the
// thinking-language sentence while keeping the final-answer language contract
// and every other policy byte-identical.
func appendCorePolicies(prompt, reasoningLanguage string) string {
	for _, policy := range []string{
		config.UserDecisionPolicy,
		config.WorkPracticePolicy,
		config.LanguagePolicyForReasoning(reasoningLanguage),
	} {
		prompt += "\n\n" + policy
	}
	return prompt
}

func appendOfflineEnvironmentNote(prompt string, offline bool) string {
	if offline {
		prompt += "\n\n" + config.OfflineEnvironmentNote
	}
	return prompt
}
