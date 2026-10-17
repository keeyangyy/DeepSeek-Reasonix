package config

import "strings"

// preserve_keys.go — in-place deletion of a top-level key. A save that clears a
// value (language = "auto") must do so without rewriting the file.

// removeTOMLTopLevelField deletes one top-level key and the lines its value
// spans, leaving the rest of the file untouched. A missing key is not an error:
// the caller describes a desired end state. Reported false means the key cannot
// be addressed as a plain assignment, so the caller must stop rather than guess.
func removeTOMLTopLevelField(body, key string) (string, bool) {
	if strings.TrimSpace(key) == "" {
		return body, false
	}
	spans := tomlLineSpans(body)
	for i, span := range spans {
		if _, _, ok := tomlEditSectionHeader(span.text); ok {
			// Top-level keys only live before the first table header.
			return body, true
		}
		got, ok := tomlTopLevelKey(span.text)
		if !ok || got != key {
			continue
		}
		end := tomlValueEndSpan(spans, i)
		return body[:span.start] + body[spans[end].end:], true
	}
	return body, true
}
