package main

import (
	"encoding/json"
	"reasonix/internal/sessioncatalog"
	"strings"
)

// sessionCatalogMetadataFingerprint derives a stable identity for the metadata
// set fed into Catalog.SyncMetadata. Orderings are deterministic (global topics,
// then projects in file order), so a marshaled comparison is exact.
func sessionCatalogMetadataFingerprint(projects []sessioncatalog.ProjectRecord, topics []sessioncatalog.TopicMetadata) string {
	if len(projects) == 0 && len(topics) == 0 {
		return ""
	}
	projectsJSON, _ := json.Marshal(projects)
	topicsJSON, _ := json.Marshal(topics)
	var buf strings.Builder
	buf.Write(projectsJSON)
	buf.WriteByte(0)
	buf.Write(topicsJSON)
	return buf.String()
}
