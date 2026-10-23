package sessioninbox

import (
	"errors"
	"path/filepath"
	"testing"
)

// openReleaseStore builds a store whose only item is an accepted steer, which is
// the state a "this turn" queue row sits in while the agent may still read it.
func openReleaseStore(t *testing.T) (*Store, string) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "s.jsonl"), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := s.Enqueue(EnqueueRequest{Envelope: PromptEnvelope{SubmitText: "steer"}})
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.AcceptSteer(rec.ItemID); err != nil {
		s.Close()
		t.Fatal(err)
	}
	return s, rec.ItemID
}

// itemState reads one item's state out of a snapshot, since InboxSnapshot only
// exposes the slice.
func itemState(t *testing.T, s *Store, id string) InboxState {
	t.Helper()
	for _, item := range s.Snapshot().Items {
		if item.ID == id {
			return item.State
		}
	}
	t.Fatalf("item %q missing from snapshot", id)
	return ""
}

// itemIntent reads one item's intent, which is what fronts group rows by.
func itemIntent(t *testing.T, s *Store, id string) InboxIntent {
	t.Helper()
	for _, item := range s.Snapshot().Items {
		if item.ID == id {
			return item.Intent
		}
	}
	t.Fatalf("item %q missing from snapshot", id)
	return ""
}

// TestReleaseAcceptedSteerReturnsToQueue is the happy path: an accepted steer
// the agent has not read yet goes back to the next-turn queue and is dispatchable.
func TestReleaseAcceptedSteerReturnsToQueue(t *testing.T) {
	s, id := openReleaseStore(t)
	defer s.Close()

	if err := s.ReleaseAcceptedSteer(id); err != nil {
		t.Fatalf("ReleaseAcceptedSteer = %v, want nil", err)
	}
	if got := itemState(t, s, id); got != StateQueued {
		t.Fatalf("state = %q, want %q", got, StateQueued)
	}
	// Fronts group rows by intent, so a released row must also leave the steer
	// group; otherwise a refresh pulls it back into the current-turn list.
	if got := itemIntent(t, s, id); got != IntentFollowup {
		t.Fatalf("intent = %q, want %q", got, IntentFollowup)
	}
	next, ok := s.NextQueued()
	if !ok || next.ID != id {
		t.Fatalf("NextQueued = (%q, %v), want (%q, true)", next.ID, ok, id)
	}
}

// TestReleaseAcceptedSteerWithdrawsFromConsumer pins the reason release is safe:
// the loader commits MarkSteerConsumed before returning the body, so once the
// item is queued again that compare-and-transition refuses and the guidance is
// not applied to the running turn.
func TestReleaseAcceptedSteerWithdrawsFromConsumer(t *testing.T) {
	s, id := openReleaseStore(t)
	defer s.Close()

	if err := s.ReleaseAcceptedSteer(id); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSteerConsumed(id); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("MarkSteerConsumed after release = %v, want ErrInvalidState", err)
	}
	if got := s.Snapshot().Items[0].State; got != StateQueued {
		t.Fatalf("state = %q, want %q", got, StateQueued)
	}
}

// TestReleaseAcceptedSteerRefusesConsumed keeps a delivered message out of the
// queue: release must not resurrect guidance the turn already applied.
func TestReleaseAcceptedSteerRefusesConsumed(t *testing.T) {
	s, id := openReleaseStore(t)
	defer s.Close()

	if err := s.MarkSteerConsumed(id); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseAcceptedSteer(id); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("ReleaseAcceptedSteer on consumed = %v, want ErrInvalidState", err)
	}
	if got := s.Snapshot().Items[0].State; got != StateSteerConsumed {
		t.Fatalf("state = %q, want %q", got, StateSteerConsumed)
	}
}

// TestReleaseAcceptedSteerRefusesQueued rejects a redundant release so the
// caller learns its view of the row is stale instead of silently succeeding.
func TestReleaseAcceptedSteerRefusesQueued(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "s.jsonl"), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rec, err := s.Enqueue(EnqueueRequest{Envelope: PromptEnvelope{SubmitText: "queued"}})
	if err != nil {
		t.Fatal(err)
	}

	if err := s.ReleaseAcceptedSteer(rec.ItemID); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("ReleaseAcceptedSteer on queued = %v, want ErrInvalidState", err)
	}
}

// TestReleaseAcceptedSteerMissingItem reports a deleted item rather than a state
// error, so the frontend can drop the row instead of offering a retry.
func TestReleaseAcceptedSteerMissingItem(t *testing.T) {
	s, id := openReleaseStore(t)
	defer s.Close()

	// DeleteItem refuses an accepted steer, so removal goes through the path that
	// is allowed to delete one.
	if err := s.DeletePendingOrAcceptedItem(id); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseAcceptedSteer(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ReleaseAcceptedSteer on missing item = %v, want ErrNotFound", err)
	}
}

// itemIDs lists the manifest order, which is what a snapshot hands to the
// frontend after a refresh.
func itemIDs(s *Store) []string {
	items := s.Snapshot().Items
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

// TestRequeueOnGroupChange pins where a row lands when it moves between the
// current-turn and next-turn groups. Entering a group is a fresh arrival, so the
// row goes to the tail; a state change that stays in the same group must not
// reorder anything. Both are read from the manifest order, because a refresh
// rebuilds the list from it.
func TestRequeueOnGroupChange(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "s.jsonl"), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	first, err := s.Enqueue(EnqueueRequest{Envelope: PromptEnvelope{SubmitText: "first"}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Enqueue(EnqueueRequest{Envelope: PromptEnvelope{SubmitText: "second"}})
	if err != nil {
		t.Fatal(err)
	}

	// Admitting the first row into this turn moves it past the row that is still
	// waiting, so the current-turn group reads oldest-first.
	if err := s.AcceptSteer(first.ItemID); err != nil {
		t.Fatalf("AcceptSteer = %v, want nil", err)
	}
	if got, want := itemIDs(s), []string{second.ItemID, first.ItemID}; !equalStrings(got, want) {
		t.Fatalf("after AcceptSteer order = %v, want %v", got, want)
	}

	// Handing it back returns it to the tail of the next-turn queue, so it does
	// not resume the slot it held before it was admitted.
	if err := s.ReleaseAcceptedSteer(first.ItemID); err != nil {
		t.Fatalf("ReleaseAcceptedSteer = %v, want nil", err)
	}
	if got, want := itemIDs(s), []string{second.ItemID, first.ItemID}; !equalStrings(got, want) {
		t.Fatalf("after ReleaseAcceptedSteer order = %v, want %v", got, want)
	}

	// Re-admitting and then flagging the steer as uncertain stays inside the
	// current-turn group, so the order must be left alone.
	if err := s.AcceptSteer(first.ItemID); err != nil {
		t.Fatal(err)
	}
	before := itemIDs(s)
	if err := s.MarkAcceptedSteerUncertain(first.ItemID, "turn ended early"); err != nil {
		t.Fatalf("MarkAcceptedSteerUncertain = %v, want nil", err)
	}
	if got := itemIDs(s); !equalStrings(got, before) {
		t.Fatalf("uncertain reordered the manifest: %v, want %v", got, before)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
