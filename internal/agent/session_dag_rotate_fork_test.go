package agent

import (
	"reasonix/internal/provider"
	"strings"
	"testing"
	"time"
)

// A fork or concurrent head reuses its parent's whole chain, so the live size
// must count the shared prefix once. Summing per-head chains inflates the
// bound past any real log size, which silently starves rotation forever.
func TestDAGLiveBytesCountsSharedPrefixOnce(t *testing.T) {
	path := dagTestSession(t)
	dagLinearLog(t, path)
	base := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	// The concurrent head starts at U2, so it shares sys/q1/U2 with main.
	dagAppend(t, path,
		sessionDAGEntry{Type: sessionDAGTypeFork, Head: SessionMainHead, NewHead: "C", From: "U2", Kind: HeadKindConcurrent, Writer: "w-b", At: base},
		dagMessageEntry(t, "C", "U2", "", dagMsg(provider.RoleAssistant, "concurrent-answer", "C1"), base.Add(time.Minute)),
	)
	st := dagReplay(t, path)
	if len(st.liveHeads()) != 2 {
		t.Fatalf("live heads = %v", st.liveHeads())
	}

	summed := int64(0)
	for _, id := range st.liveHeads() {
		msgs, _ := st.materialize(id)
		_, size, err := digestAndSizeSessionMessages(msgs)
		if err != nil {
			t.Fatal(err)
		}
		summed += size
	}
	got := sessionDAGLiveBytes(st)
	if got >= summed {
		t.Fatalf("live bytes %d must be below the per-head sum %d (shared prefix counted twice)", got, summed)
	}

	// The union is exactly the reachable nodes, so it must match the log a
	// rotation would keep.
	keep := st.reachable()
	union := make([]provider.Message, 0, len(keep))
	seen := map[string]bool{}
	for _, id := range st.liveHeads() {
		for _, mid := range st.chainIDs(id) {
			if seen[mid] {
				continue
			}
			seen[mid] = true
			union = append(union, st.appliedMessage(st.nodes[mid]))
		}
	}
	_, want, err := digestAndSizeSessionMessages(union)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("live bytes = %d, reachable union = %d", got, want)
	}
}

// The bound must trip for a log that a rotation would actually shrink, even
// when a second head doubles the per-head sum. The fixture is sized so the
// corrected bound and the inflated one land on opposite sides of the same log.
func TestDAGLogOversizedTripsWithSharedPrefixHead(t *testing.T) {
	path := dagTestSession(t)
	base := time.Date(2026, 1, 8, 10, 0, 0, 0, time.UTC)
	// A shared prefix big enough to dominate the compact floor, so the two
	// bounds genuinely differ by a factor of two.
	big := strings.Repeat("x", 100*1024)
	dagAppend(t, path,
		sessionDAGEntry{Type: sessionDAGTypeLog, Generation: 1, At: base},
		dagMessageEntry(t, SessionMainHead, "", "", dagMsg(provider.RoleSystem, "sys", "S0"), base),
		dagMessageEntry(t, SessionMainHead, "S0", "", dagMsg(provider.RoleUser, big, "U1"), base.Add(time.Second)),
		sessionDAGEntry{Type: sessionDAGTypeFork, Head: SessionMainHead, NewHead: "C", From: "U1", Kind: HeadKindConcurrent, Writer: "w-b", At: base.Add(2 * time.Minute)},
		dagMessageEntry(t, "C", "U1", "", dagMsg(provider.RoleAssistant, "concurrent-answer", "C1"), base.Add(3*time.Minute)),
	)
	st := dagReplay(t, path)
	if len(st.liveHeads()) != 2 {
		t.Fatalf("live heads = %v", st.liveHeads())
	}

	union := sessionDAGLiveBytes(st)
	summed := int64(0)
	for _, id := range st.liveHeads() {
		msgs, _ := st.materialize(id)
		_, size, _ := digestAndSizeSessionMessages(msgs)
		summed += size
	}
	unionLimit := max(sessionEventLogCompactFloor, union*sessionEventLogCompactFactor)
	summedLimit := max(sessionEventLogCompactFloor, summed*sessionEventLogCompactFactor)
	if unionLimit >= summedLimit {
		t.Fatalf("fixture cannot separate the bounds: union limit %d >= inflated limit %d", unionLimit, summedLimit)
	}

	// A log just past the corrected bound, still well under the inflated one.
	st.size = unionLimit + 1
	if !sessionDAGLogOversized(st) {
		t.Fatalf("log of %d bytes over live chains must be oversized", st.size)
	}
	if st.size >= summedLimit {
		t.Fatalf("fixture log %d also trips the inflated bound %d; test proves nothing", st.size, summedLimit)
	}
}

// With a single head, sessionDAGLiveBytes must equal the encoded size of the
// transcript materialize returns — including both shapes a system override
// can take.
func TestDAGLiveBytesMatchesMaterializeForSingleHead(t *testing.T) {
	user := dagMsg(provider.RoleUser, "hi", "U1")
	sys := dagMsg(provider.RoleSystem, "sys", "S0")
	override := dagMsg(provider.RoleSystem, "override", "S0")

	cases := []struct {
		name   string
		nodes  map[string]*sessionDAGNode
		leaf   string
		system *provider.Message
	}{
		{
			name: "no override",
			nodes: map[string]*sessionDAGNode{
				"S0": {id: "S0", msg: sys},
				"U1": {id: "U1", parent: "S0", msg: user},
			},
			leaf: "U1",
		},
		{
			name: "override replaces a system root",
			nodes: map[string]*sessionDAGNode{
				"S0": {id: "S0", msg: sys},
				"U1": {id: "U1", parent: "S0", msg: user},
			},
			leaf:   "U1",
			system: &override,
		},
		{
			name: "override prepends when the root is not a system message",
			nodes: map[string]*sessionDAGNode{
				"U1": {id: "U1", msg: user},
			},
			leaf:   "U1",
			system: &override,
		},
	}
	for _, tc := range cases {
		st := newSessionDAGState("")
		st.nodes = tc.nodes
		head := st.heads[SessionMainHead]
		head.leaf, head.system = tc.leaf, tc.system
		msgs, _ := st.materialize(SessionMainHead)
		_, want, err := digestAndSizeSessionMessages(msgs)
		if err != nil {
			t.Fatalf("%s: size materialized transcript: %v", tc.name, err)
		}
		if got := sessionDAGLiveBytes(st); got != want {
			t.Errorf("%s: live bytes = %d, materialize = %d (%d msgs)", tc.name, got, want, len(msgs))
		}
	}
}
