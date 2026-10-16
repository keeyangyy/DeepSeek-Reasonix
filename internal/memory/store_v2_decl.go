package memory

// removeLegacyScopeDuplicate archives a same-named fact in the other scope so an
// unqualified update keeps one active copy. The index is read before any file
// moves, so an unreadable index aborts instead of dropping the duplicate.
func (s Store) removeLegacyScopeDuplicate(dir string, m Memory) error {
	for _, otherDir := range s.dirs() {
		if sameDir(otherDir, dir) {
			continue
		}
		duplicate, _, ok := s.findActiveInDir(otherDir, m.Name)
		if !ok || duplicate.ID == m.ID {
			continue
		}
		lines, _, err := indexLinesExceptIn(otherDir, duplicate.Name)
		if err != nil {
			return err
		}
		if _, err := archiveInDir(otherDir, duplicate.Name); err != nil {
			return err
		}
		if err := flushIndexIn(otherDir, lines); err != nil {
			return err
		}
	}
	return nil
}
