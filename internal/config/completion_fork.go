package config

import (
	"fmt"
	"strings"
)

// renderAgentTaskBudget writes the [agent] spend-gate keys in full-render mode.
// Keys are emitted as commented defaults when unset, so the annotated template
// survives round-trips and documents the axis names for discovery.
func renderAgentTaskBudget(b *strings.Builder, c *Config) {
	if c.Agent.TaskCostBudget > 0 {
		fmt.Fprintf(b, "task_cost_budget = %s   # task spend gate in the model's pricing currency; off unless set\n", formatFloat(c.Agent.TaskCostBudget))
	} else {
		b.WriteString("# task_cost_budget = 0.0   # task spend gate in the model's pricing currency; off unless set\n")
	}
	if c.Agent.TaskTimeBudgetMinutes > 0 {
		fmt.Fprintf(b, "task_time_budget_minutes = %s   # task wall-clock gate in minutes; off unless set\n", formatFloat(c.Agent.TaskTimeBudgetMinutes))
	} else {
		b.WriteString("# task_time_budget_minutes = 0   # task wall-clock gate in minutes; off unless set\n")
	}
	if c.Agent.GoalTokenBudget > 0 {
		fmt.Fprintf(b, "goal_token_budget = %d   # cumulative Goal token gate; off unless set\n", c.Agent.GoalTokenBudget)
	} else {
		b.WriteString("# goal_token_budget = 0   # cumulative Goal token gate; off unless set\n")
	}
}

// diffAgentTaskBudget emits a spend-gate key only when it differs from the
// built-in default in the incremental project-scope renderer.
func diffAgentTaskBudget(agentBuf *strings.Builder, c, d Config, anyAgent *bool) {
	if c.Agent.TaskCostBudget > 0 && c.Agent.TaskCostBudget != d.Agent.TaskCostBudget {
		fmt.Fprintf(agentBuf, "task_cost_budget = %s\n", formatFloat(c.Agent.TaskCostBudget))
		*anyAgent = true
	}
	if c.Agent.TaskTimeBudgetMinutes > 0 && c.Agent.TaskTimeBudgetMinutes != d.Agent.TaskTimeBudgetMinutes {
		fmt.Fprintf(agentBuf, "task_time_budget_minutes = %s\n", formatFloat(c.Agent.TaskTimeBudgetMinutes))
		*anyAgent = true
	}
	if c.Agent.GoalTokenBudget > 0 && c.Agent.GoalTokenBudget != d.Agent.GoalTokenBudget {
		fmt.Fprintf(agentBuf, "goal_token_budget = %d\n", c.Agent.GoalTokenBudget)
		*anyAgent = true
	}
}
