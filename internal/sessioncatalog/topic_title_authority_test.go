package sessioncatalog

import (
	"context"
	"path/filepath"
	"testing"
)

// The derived topic recompute owns aggregates, not the title: a session-side
// snapshot can be a stale placeholder (an auto-named conversation whose sidecar
// was never rewritten) and must not roll a published title back.

func TestRecomputeKeepsPublishedTopicTitle(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	catalog, err := Open(ctx, Options{Path: filepath.Join(t.TempDir(), "catalog.sqlite"), DisableRepair: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = catalog.Close(context.Background()) })

	if err := catalog.SyncMetadata(ctx, nil, []TopicMetadata{{
		Scope: "project", WorkspaceRoot: `C:\ws`, TopicID: "t1",
		Title: "帮我增加一个功能", TitleSource: "auto",
	}}); err != nil {
		t.Fatal(err)
	}

	record := SessionRecord{
		Path: `C:\ws\sessions\s1.jsonl`, Directory: `C:\ws\sessions`, Scope: "project",
		WorkspaceRoot: `C:\ws`, TopicID: "t1", TopicTitle: "新的会话",
		LastActivityAt: 10, Turns: 3, TurnsState: TurnsValid, Health: HealthOK,
	}
	if err := catalog.UpsertSession(ctx, record); err != nil {
		t.Fatal(err)
	}

	topic, ok, err := catalog.GetTopic(ctx, TopicKey{Scope: "project", WorkspaceRoot: `C:\ws`, TopicID: "t1"})
	if err != nil || !ok {
		t.Fatalf("get topic: ok=%v err=%v", ok, err)
	}
	if topic.Title != "帮我增加一个功能" {
		t.Fatalf("topic title after a session change = %q, want the published title", topic.Title)
	}
	if topic.Turns != 3 {
		t.Fatalf("topic turns = %d, want the recomputed 3", topic.Turns)
	}
}

// Without published metadata the derived title is still the only name a topic
// has, so the session-side value must keep being adopted.
func TestRecomputeAdoptsSessionTitleWithoutMetadata(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	catalog, err := Open(ctx, Options{Path: filepath.Join(t.TempDir(), "catalog.sqlite"), DisableRepair: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = catalog.Close(context.Background()) })

	record := SessionRecord{
		Path: `C:\ws\sessions\s2.jsonl`, Directory: `C:\ws\sessions`, Scope: "project",
		WorkspaceRoot: `C:\ws`, TopicID: "t2", TopicTitle: "Session side title",
		LastActivityAt: 10, Turns: 1, TurnsState: TurnsValid, Health: HealthOK,
	}
	if err := catalog.UpsertSession(ctx, record); err != nil {
		t.Fatal(err)
	}

	topic, ok, err := catalog.GetTopic(ctx, TopicKey{Scope: "project", WorkspaceRoot: `C:\ws`, TopicID: "t2"})
	if err != nil || !ok {
		t.Fatalf("get topic: ok=%v err=%v", ok, err)
	}
	if topic.Title != "Session side title" {
		t.Fatalf("topic title without metadata = %q, want the session-side title", topic.Title)
	}
}
