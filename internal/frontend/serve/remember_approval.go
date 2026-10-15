package serve

import (
	"encoding/json"
	"net/http"
)

func (s *Server) rememberApprovalSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, s.ctl().RememberApprovalSettings())
}

// saveRememberApprovalSettings rides the provider-edit grant: switching a
// confirmation off lets the agent persist memories without asking, and one of
// them reaches every project.
func (s *Server) saveRememberApprovalSettings(w http.ResponseWriter, r *http.Request) {
	if !s.grants.at(r).providerEdit {
		refuse(w, http.StatusForbidden, "remember_approval.editing_disabled", "memory-write editing is not enabled on this server", nil)
		return
	}
	var body struct {
		ProjectAutoConfirm *bool `json:"projectAutoConfirm"`
		GlobalAutoConfirm  *bool `json:"globalAutoConfirm"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		badBody(w)
		return
	}
	if body.ProjectAutoConfirm == nil || body.GlobalAutoConfirm == nil {
		refuse(w, http.StatusBadRequest, "remember_approval.no_scope", "both switches are required", nil)
		return
	}
	if err := s.ctl().SaveRememberApproval(*body.ProjectAutoConfirm, *body.GlobalAutoConfirm); err != nil {
		// A boolean cannot be a bad request: what is left is the file or the disk.
		saveFailed(w, http.StatusInternalServerError, "remember_approval.save_failed", err)
		return
	}
	if err := s.rebuildInPlace(r.Context()); err != nil {
		rebuildFailed(w, err)
		return
	}
	writeJSON(w, s.ctl().RememberApprovalSettings())
}
