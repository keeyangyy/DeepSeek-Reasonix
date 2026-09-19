package main

import (
	"strings"

	"reasonix/internal/sessioncatalog"
)

// The session list and history panel render the per-session title snapshot the
// projection copied from the session sidecar. That copy can be a stale
// placeholder (an auto-named conversation whose sidecar was never rewritten),
// so those views kept showing「新的会话」while the sidebar — which reads the
// topic layer — showed the real name. Reading views resolve the placeholder
// against the authoritative topic layer instead.
type sessionTopicTitleResolver struct {
	titles map[string]map[string]string
}

func newSessionTopicTitleResolver() *sessionTopicTitleResolver {
	return &sessionTopicTitleResolver{titles: map[string]map[string]string{}}
}

// authoritative returns the topic-layer name for one topic, or "" when the
// topic is unnamed (missing, empty, or still carrying a placeholder). Titles
// are read once per workspace root so a page of sessions costs one snapshot.
func (r *sessionTopicTitleResolver) authoritative(scope, workspaceRoot, topicID string) string {
	topicID = strings.TrimSpace(topicID)
	if r == nil || topicID == "" {
		return ""
	}
	root := topicTitleRoot(scope, workspaceRoot)
	key := scope + "\x00" + root
	titles, ok := r.titles[key]
	if !ok {
		titles = loadTopicTitles(root)
		r.titles[key] = titles
	}
	title := strings.TrimSpace(titles[topicID])
	if title == "" || isDefaultTopicTitle(title) {
		return ""
	}
	return title
}

// resolve keeps a real session-side title and replaces a placeholder with the
// authoritative one. When neither names the conversation the stored value stays
// so callers keep their existing preview fallback.
func (r *sessionTopicTitleResolver) resolve(scope, workspaceRoot, topicID, stored string) string {
	stored = strings.TrimSpace(stored)
	if stored != "" && !isDefaultTopicTitle(stored) {
		return stored
	}
	if authoritative := r.authoritative(scope, workspaceRoot, topicID); authoritative != "" {
		return authoritative
	}
	return stored
}

// sessionMetaFromCatalogResolved builds one session-list row, letting the topic
// layer resolve a placeholder title.
func sessionMetaFromCatalogResolved(record sessioncatalog.SessionRecord, current, open bool, topics *sessionTopicTitleResolver) SessionMeta {
	meta := sessionMetaFromCatalog(record, current, open)
	meta.TopicTitle = topics.resolve(record.Scope, record.WorkspaceRoot, record.TopicID, meta.TopicTitle)
	return meta
}
