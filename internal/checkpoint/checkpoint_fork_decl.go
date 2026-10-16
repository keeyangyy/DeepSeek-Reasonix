package checkpoint

// ForkBoundary is a conversation-only checkpoint boundary exported for
// inheritance into a forked session — deliberately without any file snapshot
// payload, because the fork's workspace state does not match the source's.
type ForkBoundary struct {
	Turn     int
	Prompt   string
	MsgIndex int
}

// ExportForkBoundaries returns the conversation boundaries for turns up to and
// including turnLimit (the fork point). File snapshots are never included:
// a fork must not offer "restore code" against its (different) workspace.
func (s *Store) ExportForkBoundaries(turnLimit int) []ForkBoundary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ForkBoundary, 0, len(s.done))
	for _, c := range s.done {
		if c.Turn > turnLimit {
			continue
		}
		out = append(out, ForkBoundary{Turn: c.Turn, Prompt: c.Prompt, MsgIndex: c.MsgIndex})
	}
	return out
}

// ImportForkBoundaries persists conversation-only boundaries (no file
// snapshots) into this store and registers them in memory. A forked session
// that inherits them keeps conversation rewind / "summarize" availability
// (checkpoint boundary liveness) without inheriting any file-restore payload.
// ImportForkBoundaries holds s.mu.
func (s *Store) ImportForkBoundaries(boundaries []ForkBoundary) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range boundaries {
		c := &Checkpoint{
			SchemaVersion: SchemaV3,
			Turn:          b.Turn,
			Prompt:        b.Prompt,
			MsgIndex:      b.MsgIndex,
		}
		if err := s.persist(c); err != nil {
			return err
		}
		s.done = append(s.done, c)
	}
	return nil
}
