package control

import (
	"encoding/json"

	"reasonix/internal/contract/config"
	"reasonix/internal/contract/event"
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
// short-circuit, and neither covers forget; the content floor the assessment
// keeps means a sensitive body still asks however the switch is set. The
// assessment travels so the gate can name the fact in the receipt it owes.
func (c *Controller) allowRememberByScope(args json.RawMessage) memory.RememberAssessment {
	mem := c.Memory()
	// This call owns the mark from here on: whatever an earlier one left is
	// stale by definition.
	c.memory.clearReceipt()
	if mem == nil || (!c.autoConfirmProjectRemember && !c.autoConfirmGlobalRemember) {
		return memory.RememberAssessment{Reason: "the switch is off"}
	}
	if memory.RememberWriteScope(mem.Store, args) == memory.FactScopeGlobal {
		if !c.autoConfirmGlobalRemember {
			return memory.RememberAssessment{Reason: "the global switch is off"}
		}
	} else if !c.autoConfirmProjectRemember {
		return memory.RememberAssessment{Reason: "the project switch is off"}
	}
	return memory.AssessRememberSwitch(mem.Store, args)
}

// noticeRememberSavedUnasked leaves the receipt a skipped confirmation owes: the
// name of the fact the user's switch let through, which /forget takes back. The
// kernel's own line stays English for frontends that do not localize; the detail
// is the fact's name, for the desktop card to word in the reader's language.
func (c *Controller) noticeRememberSavedUnasked(name string) {
	text := "memory saved without asking"
	if name != "" {
		text += ": " + name
	}
	c.sink.Emit(event.Event{Kind: event.Notice, Level: event.LevelInfo, Code: event.NoticeCodeMemorySavedUnasked,
		Text: text, Detail: name})
}
