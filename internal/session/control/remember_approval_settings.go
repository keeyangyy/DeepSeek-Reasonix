package control

import (
	"encoding/json"

	"reasonix/internal/contract/config"
	"reasonix/internal/state/memory"
)

// RememberApproval is the remember-confirmation switch as the user file holds
// it beside what this workspace will run with: a project file may set the same
// keys, so a panel that showed only the user's answer would describe another run.
type RememberApproval struct {
	ProjectAutoConfirm bool   `json:"projectAutoConfirm"`
	ProjectEffective   bool   `json:"projectEffective"`
	GlobalAutoConfirm  bool   `json:"globalAutoConfirm"`
	GlobalEffective    bool   `json:"globalEffective"`
	Path               string `json:"path"`
}

// RememberApprovalSettings reads [memory] auto_confirm_* from the user file and
// from the merge in force for this workspace. An absent key reads as false —
// asking is what ships — and neither key covers forget.
func (c *Controller) RememberApprovalSettings() RememberApproval {
	path := config.UserConfigPath()
	user := config.LoadForEdit(path).Memory
	out := RememberApproval{
		ProjectAutoConfirm: user.AutoConfirmProjectRemember,
		GlobalAutoConfirm:  user.AutoConfirmGlobalRemember,
		Path:               path,
	}
	out.ProjectEffective, out.GlobalEffective = out.ProjectAutoConfirm, out.GlobalAutoConfirm
	if merged, err := config.LoadForRootReadOnly(c.WorkspaceRoot()); err == nil {
		out.ProjectEffective = merged.Memory.AutoConfirmProjectRemember
		out.GlobalEffective = merged.Memory.AutoConfirmGlobalRemember
	}
	return out
}

// SaveRememberApproval persists both switches to the user file. The caller
// rebuilds: the confirmation decision belongs to the gate the runtime was built
// with, so a live session keeps its own pair until it is replaced.
func (c *Controller) SaveRememberApproval(projectAutoConfirm, globalAutoConfirm bool) error {
	unlock := config.LockUserConfigEdits()
	defer unlock()
	path := config.UserConfigPath()
	cfg := config.LoadForEdit(path)
	cfg.Memory.AutoConfirmProjectRemember = projectAutoConfirm
	cfg.Memory.AutoConfirmGlobalRemember = globalAutoConfirm
	return cfg.SaveTo(path)
}

// allowRememberByScope answers whether the user turned off confirmation for the
// scope this write lands in. It sits beside allowLowRiskRemember in the same
// short-circuit — that path covers low-risk creates, this one the user's own
// per-scope switch — and neither covers forget.
func (c *Controller) allowRememberByScope(args json.RawMessage) bool {
	if !c.autoConfirmProjectRemember && !c.autoConfirmGlobalRemember {
		return false
	}
	mem := c.Memory()
	if mem == nil {
		return false
	}
	if memory.RememberWriteScope(mem.Store, args) == memory.FactScopeGlobal {
		return c.autoConfirmGlobalRemember
	}
	return c.autoConfirmProjectRemember
}
