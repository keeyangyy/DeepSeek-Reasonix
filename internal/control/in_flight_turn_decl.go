package control

// OpenTurnID returns the id of the turn currently open on this controller's
// session (empty when none). Frontends use it to align the live rows of the
// in-flight turn (a:<turnId>:…) with the fetched history page. It reads only
// the session's open-turn marker, which is safe during a concurrent save.
func (c *Controller) OpenTurnID() string {
	if s := c.loggedTurnSession(); s != nil {
		if turn, open := s.OpenTurn(); open {
			return turn.TurnID
		}
	}
	return ""
}
