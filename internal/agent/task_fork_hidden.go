package agent

// readOnlySubagentWorkflowToolNames lists workflow tools that must stay hidden
// from read-only subagents. connect_tool_source is retired and unregistered;
// listing it is defensive so a future re-registration cannot silently hand
// read-only subagents a connector they may never hold.
func readOnlySubagentWorkflowToolNames() []string {
	return []string{"connect_tool_source"}
}
