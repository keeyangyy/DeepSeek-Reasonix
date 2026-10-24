package sessioninbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// openRevisionStore enqueues two follow-ups and returns the store plus both ids.
// Two items are needed because a move is only observable relative to a sibling.
func openRevisionStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	session := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(session, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	first := enqueueRevisionItem(t, s, "first")
	second := enqueueRevisionItem(t, s, "second")
	return s, first, second
}

func enqueueRevisionItem(t *testing.T, s *Store, text string) string {
	t.Helper()
	rec, err := s.Enqueue(EnqueueRequest{
		Intent:   IntentFollowup,
		Envelope: PromptEnvelope{DisplayText: text, SubmitText: text},
		Source:   "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	return rec.ItemID
}

func itemRevision(t *testing.T, s *Store, id string) int64 {
	t.Helper()
	for _, it := range s.Snapshot().Items {
		if it.ID == id {
			return it.Revision
		}
	}
	t.Fatalf("item %q missing from snapshot", id)
	return 0
}

// A write that carries the version the caller read must land.
func TestUpdateItemIfCurrentAcceptsCurrentRevision(t *testing.T) {
	s, id, _ := openRevisionStore(t)
	want := itemRevision(t, s, id)

	_, err := s.UpdateItemAllowingAcceptedSteerIfCurrent(id, PromptEnvelope{
		DisplayText: "edited", SubmitText: "edited",
	}, want)
	if err != nil {
		t.Fatalf("update at current revision = %v, want success", err)
	}
	if got := itemRevision(t, s, id); got <= want {
		t.Fatalf("revision after edit = %d, want it above %d", got, want)
	}
}

// A write that carries a superseded version must be refused rather than
// overwriting the intervening change.
func TestUpdateItemIfCurrentRejectsStaleRevision(t *testing.T) {
	s, id, _ := openRevisionStore(t)
	stale := itemRevision(t, s, id)

	if _, err := s.UpdateItemAllowingAcceptedSteerIfCurrent(id, PromptEnvelope{
		DisplayText: "first edit", SubmitText: "first edit",
	}, stale); err != nil {
		t.Fatalf("first edit = %v", err)
	}

	_, err := s.UpdateItemAllowingAcceptedSteerIfCurrent(id, PromptEnvelope{
		DisplayText: "second edit", SubmitText: "second edit",
	}, stale)
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale edit = %v, want ErrRevisionConflict", err)
	}
	// The refused write must not have replaced the body it never saw.
	_, env, err := s.ReadItem(id)
	if err != nil {
		t.Fatal(err)
	}
	if env.DisplayText != "first edit" {
		t.Fatalf("body = %q after refused write, want the surviving edit", env.DisplayText)
	}
}

// Hosts that predate the handshake send zero and keep the old behaviour.
func TestUpdateItemIfCurrentSkipsCheckOnZeroRevision(t *testing.T) {
	s, id, _ := openRevisionStore(t)
	if _, err := s.UpdateItemAllowingAcceptedSteerIfCurrent(id, PromptEnvelope{
		DisplayText: "first edit", SubmitText: "first edit",
	}, 0); err != nil {
		t.Fatalf("first edit = %v", err)
	}
	if _, err := s.UpdateItemAllowingAcceptedSteerIfCurrent(id, PromptEnvelope{
		DisplayText: "blind overwrite", SubmitText: "blind overwrite",
	}, 0); err != nil {
		t.Fatalf("zero-revision edit = %v, want it to stay permitted", err)
	}
}

// A move is a change to the row, so it must advance the item's revision too.
func TestMoveItemIfCurrentAdvancesItemRevision(t *testing.T) {
	s, first, second := openRevisionStore(t)
	before := itemRevision(t, s, first)

	if err := s.MoveItemIfCurrent(second, 0, itemRevision(t, s, second)); err != nil {
		t.Fatalf("move = %v", err)
	}
	if got := itemRevision(t, s, second); got <= before {
		t.Fatalf("moved item revision = %d, want it above %d", got, before)
	}
	// The untouched sibling keeps its version: a move is not a global bump.
	if got := itemRevision(t, s, first); got != before {
		t.Fatalf("unmoved item revision = %d, want %d", got, before)
	}
}

func TestMoveItemIfCurrentRejectsStaleRevision(t *testing.T) {
	s, _, second := openRevisionStore(t)
	stale := itemRevision(t, s, second)

	if err := s.MoveItemIfCurrent(second, 0, stale); err != nil {
		t.Fatalf("first move = %v", err)
	}
	err := s.MoveItemIfCurrent(second, 1, stale)
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale move = %v, want ErrRevisionConflict", err)
	}
}

// Replaying an idempotency alias means the caller's write already landed, so a
// later revision is not a conflict and the call must succeed.
func TestUpdateIdempotencyReplayIgnoresStaleRevision(t *testing.T) {
	s, id, _ := openRevisionStore(t)
	env := PromptEnvelope{DisplayText: "collect", SubmitText: "collect"}
	alias := PromptEnvelope{DisplayText: "collect", SubmitText: "collect"}

	first, err := s.UpdateItemWithIdempotencyIfCurrent(id, env, "msg-1", alias, 0)
	if err != nil {
		t.Fatalf("first update = %v", err)
	}
	replayed, err := s.UpdateItemWithIdempotencyIfCurrent(id, env, "msg-1", alias, first.Revision-1)
	if err != nil {
		t.Fatalf("replayed update = %v, want success, got %v", err, err)
	}
	if replayed.Revision != first.Revision {
		t.Fatalf("replay revision = %d, want the already-committed %d", replayed.Revision, first.Revision)
	}
}
