package agent

import "testing"

// The status strip shows "<name>: <content>", so a reader sees both which tool
// ran and what it was asked to do. Every source is clipped to one width here,
// at the dispatch, so no surface can render a longer label than another.
func TestSubagentDispatchLabel(t *testing.T) {
	tests := []struct {
		name        string
		tool        string
		description string
		prompt      string
		want        string
	}{
		{
			name:   "description names the work when present",
			tool:   "task",
			prompt: "调查整个仓库的并发模型，输出报告",
			want:   "task: 调查整个仓库的并发模…",
		},
		{
			name:   "prompt stands in when the description is empty",
			tool:   "read_only_task",
			prompt: "极简任务：用 web_fetch 查 rustc 1.97.1 的发布日期",
			want:   "read_only_task: 极简任务：用 web…",
		},
		{
			name:   "an agent profile names itself, not the proxy tool",
			tool:   "research",
			prompt: "查 rustc 最新版本",
			want:   "research: 查 rustc 最新…",
		},
		{
			name:   "only the prompt's first line is a label",
			tool:   "explore",
			prompt: "首行标题\n\n第二段是正文，不属于标签",
			want:   "explore: 首行标题",
		},
		{
			name:   "a short description is kept whole",
			tool:   "task",
			prompt: "any prompt",
			want:   "task: 修复并发 bug",
		},
		{
			name: "an empty dispatch degrades to the bare tool name",
			tool: "task",
			want: "task",
		},
	}
	// The table above drives content through the prompt for the cases that have
	// no description; give those a description where the case calls for one.
	descriptions := map[string]string{
		"description names the work when present": "调查整个仓库的并发模型，输出报告",
		"a short description is kept whole":       "修复并发 bug",
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SubagentDispatchLabel(tc.tool, descriptions[tc.name], tc.prompt)
			if got != tc.want {
				t.Fatalf("SubagentDispatchLabel(%q, %q, %q) = %q, want %q", tc.tool, descriptions[tc.name], tc.prompt, got, tc.want)
			}
		})
	}
}

func TestClipLabelCountsRunesNotBytes(t *testing.T) {
	// A Chinese label must clip by character; byte-clipping would cut a rune in
	// half and render a replacement glyph.
	if got := clipLabel("一二三四五六七八九十十一"); got != "一二三四五六七八九十…" {
		t.Fatalf("clipLabel = %q", got)
	}
	if got := clipLabel("短"); got != "短" {
		t.Fatalf("clipLabel kept a short label whole: %q", got)
	}
}
