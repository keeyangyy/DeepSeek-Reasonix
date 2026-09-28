package runtimepolicy

import (
	"testing"

	"reasonix/internal/evidence"
)

// ParseConstraints no longer derives a mutation ban from the user's wording.
// ForbidMutation is set only structurally, by plan mode or an inherited
// parent constraint; the prose still reaches the model as an instruction.
func TestParseConstraintsNeverBansMutationFromProse(t *testing.T) {
	for _, instruction := range []string{
		"Do not modify PR #10. Create a branch and implement the repair.",
		"Write AUDIT.md with the result. Do not change any config.",
		"Implement login. The schema: do not modify",
		"Analyze only the payment flow.",
		"Read-only review of PR #10.",
		"Do not modify anything.",
		"No changes.",
		"按方案实现登录模块，数据库结构不要改。",
		"帮我新建登录模块的前后端文件，其他不要改",
		"不要修改当前工作区。",
		"只分析支付流程。",
	} {
		t.Run(instruction, func(t *testing.T) {
			got := ParseConstraints(StripQuotedConstraints(instruction))
			if got.ForbidMutation || !got.AllowsMutation() {
				t.Fatalf("prose set a mutation ban: %+v", got)
			}
			decision := (ConstraintGuard{Constraints: got}).BeforeTool(CallContext{
				Profile: evidence.EffectProfile{Known: true, WorkspaceWrite: true},
			})
			if decision.Action == GuardDeny {
				t.Fatalf("writer decision = %+v, want no constraint denial", decision)
			}
		})
	}
}

// Plan mode is the structural read-only switch that still denies writers.
func TestPlanModeConstraintDeniesWriters(t *testing.T) {
	c := Constraints{PlanModeReadOnly: true}
	decision := (ConstraintGuard{Constraints: c}).BeforeTool(CallContext{
		Profile: evidence.EffectProfile{Known: true, WorkspaceWrite: true},
	})
	if decision.Action != GuardDeny {
		t.Fatalf("plan-mode writer decision = %+v, want deny", decision)
	}
}
