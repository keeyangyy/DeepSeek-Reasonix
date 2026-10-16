package agent

import (
	"reasonix/internal/provider"
)

// sessionDAGLiveBytes is the encoded size of the transcript a rotation keeps:
// every node reachable from a live head, counted once, plus the system
// override each head contributes. Heads share chain prefixes — a fork or a
// concurrent head reuses its parent's whole chain — so summing per-head
// chains counts that shared prefix once per head and inflates the bound until
// an oversized log can never qualify for rotation. buildRotatedSessionDAG
// keeps st.reachable(), so this must measure the same set.
func sessionDAGLiveBytes(st *sessionDAGState) int64 {
	// No size hint: st.nodes also holds nodes unreachable from any live head,
	// and this runs on every save, so reserving for all of them would allocate
	// for garbage each time.
	counted := make(map[string]struct{})
	live := int64(0)
	add := func(m provider.Message) {
		// A serialization failure only costs precision in a heuristic bound;
		// the caller treats "cannot measure" as "leave the log alone".
		if _, size, err := digestAndSizeSessionMessages([]provider.Message{m}); err == nil {
			live += size
		}
	}
	for _, id := range st.liveHeads() {
		chain := st.chainIDs(id)
		head := st.heads[id]
		// Mirror materialize: a head's system override takes the place of the
		// chain's own leading system message, and is prepended when the chain
		// does not start with one.
		overrideAtRoot := head != nil && head.system != nil && len(chain) > 0 &&
			st.appliedMessage(st.nodes[chain[0]]).Role == provider.RoleSystem
		for i, mid := range chain {
			if _, ok := counted[mid]; ok {
				continue
			}
			counted[mid] = struct{}{}
			n := st.nodes[mid]
			m := st.appliedMessage(n)
			if i == 0 && overrideAtRoot {
				m = *head.system
				m.ID = n.id
			}
			add(m)
		}
		if head != nil && head.system != nil && !overrideAtRoot {
			add(*head.system)
		}
	}
	return live
}
