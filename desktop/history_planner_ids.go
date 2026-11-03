package main

import "fmt"

// Planner display history is persisted as rows without ids: the sidecar stores
// role/content/reasoning only. Two conversion helpers live here so the adopted
// rows keep an identity of their own.

// adoptPlannerRows clones one adopted planner turn and gives every row a stable
// derived id. Without it the caller stamps the whole turn with the host message
// id, and the frontend — which dedupes history rows by messageId — collapses a
// several-hundred-row turn into the single user bubble it was attached to.
func adoptPlannerRows(hostID string, rows []HistoryMessage) []HistoryMessage {
	adopted := cloneHistoryMessages(rows)
	for i := range adopted {
		if adopted[i].ID == "" {
			adopted[i].ID = fmt.Sprintf("%s:p%d", hostID, i)
		}
	}
	return adopted
}

// stampHostMessageID fills in the host message id for rows that do not carry an
// id of their own. Rows with an id (adopted planner rows) keep it.
func stampHostMessageID(rows []HistoryMessage, hostID string) {
	for i := range rows {
		if rows[i].ID == "" {
			rows[i].ID = hostID
		}
	}
}
