package main

import (
	"strings"
)

// topicLabelFallback names a topic row: its own title when it has a real one,
// else its first session's opening message, else the placeholder. The bare
// placeholder is useless once several unnamed topics sit side by side.
func topicLabelFallback(first catalogRuntimeSnapshot) string {
	if title := strings.TrimSpace(first.topicTitle); title != "" && !isDefaultTopicTitle(title) {
		return title
	}
	if preview := sessionPreviewForPath(first.sessionPath); preview != "" {
		return preview
	}
	return defaultTopicTitle
}
