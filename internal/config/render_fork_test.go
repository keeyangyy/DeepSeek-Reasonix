package config

import (
	"github.com/BurntSushi/toml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Budget spend gates must survive the full user-scope render round-trip.
// Regression: the three keys were never emitted by the renderer, so any
// SaveTo(config.toml) silently dropped task_cost_budget /
// task_time_budget_minutes / goal_token_budget from the file.
func TestRenderTOMLRoundTripsAgentTaskBudget(t *testing.T) {
	orig := Default()
	orig.Agent.TaskCostBudget = 5.0
	orig.Agent.TaskTimeBudgetMinutes = 1440
	orig.Agent.GoalTokenBudget = 2_000_000

	rendered := RenderTOML(orig)

	var got Config
	if _, err := toml.Decode(rendered, &got); err != nil {
		t.Fatalf("rendered TOML does not parse: %v\n---\n%s", err, rendered)
	}
	if got.Agent.TaskCostBudget != 5.0 {
		t.Errorf("task_cost_budget = %v, want 5.0\n%s", got.Agent.TaskCostBudget, rendered)
	}
	if got.Agent.TaskTimeBudgetMinutes != 1440 {
		t.Errorf("task_time_budget_minutes = %v, want 1440\n%s", got.Agent.TaskTimeBudgetMinutes, rendered)
	}
	if got.Agent.GoalTokenBudget != 2_000_000 {
		t.Errorf("goal_token_budget = %d, want 2000000\n%s", got.Agent.GoalTokenBudget, rendered)
	}
}

// Unset budget gates render as commented template lines, not as zero-valued
// keys, so the annotated user template keeps documenting them.
func TestRenderTOMLAgentTaskBudgetDefaultsCommented(t *testing.T) {
	rendered := RenderTOML(Default())
	for _, want := range []string{
		"# task_cost_budget = 0.0",
		"# task_time_budget_minutes = 0",
		"# goal_token_budget = 0",
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("default template missing %q\n%s", want, rendered)
		}
	}
}

// The project-scope incremental renderer must emit a budget key only when it
// differs from the built-in default, mirroring recovery_model behavior.
func TestProjectDeltaRendersAgentTaskBudgetOverrides(t *testing.T) {
	c := Default()
	c.Agent.TaskCostBudget = 3.5
	c.Agent.TaskTimeBudgetMinutes = 60
	c.Agent.GoalTokenBudget = 100_000

	delta := RenderTOMLProjectDelta(c)
	for _, want := range []string{
		"[agent]",
		"task_cost_budget = 3.5",
		"task_time_budget_minutes = 60",
		"goal_token_budget = 100000",
	} {
		if !strings.Contains(delta, want) {
			t.Fatalf("project delta missing %q:\n%s", want, delta)
		}
	}
}

// An unset budget must not leak into the project-scope delta at all.
func TestProjectDeltaOmitsAgentTaskBudgetWhenDefault(t *testing.T) {
	delta := RenderTOMLProjectDelta(Default())
	for _, forbidden := range []string{"task_cost_budget", "task_time_budget_minutes", "goal_token_budget"} {
		if strings.Contains(delta, forbidden) {
			t.Fatalf("project delta rendered default %s:\n%s", forbidden, delta)
		}
	}
}

// SaveTo must not drop the budget spend gates — this is the exact regression
// users hit: writing any setting through the annotated user template silently
// deleted task_cost_budget / task_time_budget_minutes / goal_token_budget.
func TestSaveToKeepsAgentTaskBudgetKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	cfg := Default()
	cfg.Agent.TaskCostBudget = 5.0
	cfg.Agent.TaskTimeBudgetMinutes = 1440
	cfg.Agent.GoalTokenBudget = 2_000_000

	if err := cfg.SaveTo(path); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"task_cost_budget = 5",
		"task_time_budget_minutes = 1440",
		"goal_token_budget = 2000000",
	} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("saved config lost %q:\n%s", want, raw)
		}
	}

	// Round-trip: the file must load back with the gates intact.
	got := LoadForEdit(path)
	if got.Agent.TaskCostBudget != 5.0 || got.Agent.TaskTimeBudgetMinutes != 1440 || got.Agent.GoalTokenBudget != 2_000_000 {
		t.Fatalf("round-trip lost budget gates: %+v", got.Agent)
	}
}
