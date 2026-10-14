package main

import (
	"testing"

	"reasonix/internal/sessioncatalog"
)

// The session list and history panel render the session-side title snapshot the
// projection copied from the sidecar. When that snapshot is a placeholder the
// topic-layer name must win, or auto-named conversations keep showing「新的会话」.

func TestSessionTopicTitleResolverPrefersAuthoritativeTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := t.TempDir()
	if err := setTopicTitleWithSource(root, "topic-named", "帮我增加一个功能", topicTitleSourceAuto); err != nil {
		t.Fatalf("set topic title: %v", err)
	}
	record := sessioncatalog.SessionRecord{
		Path: root + `\sessions\s1.jsonl`, Scope: "project", WorkspaceRoot: root,
		TopicID: "topic-named", TopicTitle: "新的会话",
	}
	meta := sessionMetaFromCatalogResolved(record, false, false, newSessionTopicTitleResolver())
	if meta.TopicTitle != "帮我增加一个功能" {
		t.Fatalf("topic title = %q, want the authoritative name", meta.TopicTitle)
	}
}

func TestSessionTopicTitleResolverKeepsRealSessionTitle(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := t.TempDir()
	if err := setTopicTitleWithSource(root, "topic-other", "Topic layer name", topicTitleSourceAuto); err != nil {
		t.Fatalf("set topic title: %v", err)
	}
	record := sessioncatalog.SessionRecord{
		Path: root + `\sessions\s2.jsonl`, Scope: "project", WorkspaceRoot: root,
		TopicID: "topic-other", TopicTitle: "Session side name",
	}
	meta := sessionMetaFromCatalogResolved(record, false, false, newSessionTopicTitleResolver())
	if meta.TopicTitle != "Session side name" {
		t.Fatalf("topic title = %q, want the session-side name preserved", meta.TopicTitle)
	}
}

// An unnamed topic must keep the placeholder so the existing preview fallback
// still applies: inventing a name here would be a worse bug than the label.
func TestSessionTopicTitleResolverKeepsPlaceholderWhenTopicUnnamed(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := t.TempDir()
	record := sessioncatalog.SessionRecord{
		Path: root + `\sessions\s3.jsonl`, Scope: "project", WorkspaceRoot: root,
		TopicID: "topic-unnamed", TopicTitle: "新的会话",
	}
	meta := sessionMetaFromCatalogResolved(record, false, false, newSessionTopicTitleResolver())
	if meta.TopicTitle != "新的会话" {
		t.Fatalf("topic title = %q, want the placeholder preserved for the preview fallback", meta.TopicTitle)
	}
}
