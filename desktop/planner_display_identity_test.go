package main

import (
	"testing"

	"reasonix/internal/agent"
	"reasonix/internal/provider"
)

// 复现 core：planner 显示行与宿主 user 消息共用同一个消息 ID。
//
// 会话目录的 .planner-display.json 会把一整轮 planner 消息挂在某条 user 消息的
// userHash 下。convertHistoryMessageRows 命中后把这些行追加到该 user 行之后，
// 紧接着 convertHistoryMessage 用 `rows[i].ID = m.ID` 无差别覆盖，于是整轮
// planner 行都继承了这条 user 消息的身份。
//
// 前端按 messageID 去重/合并历史条目，这些行因此被当作同一条消息反复处理，
// 正文淹没、中间内容整段不显示（app_wails / matlab wails 会话 21:17–22:06）。
func TestPlannerDisplayRowsInheritHostMessageID(t *testing.T) {
	host := provider.Message{ID: "01HOSTUSER", Role: provider.RoleUser, Content: "探索一下 matlab wails 的可行性"}
	planner := []HistoryMessage{
		{Role: "assistant", Content: "", Reasoning: "先看仓库结构"},
		{Role: "assistant", Content: "结论：可行", Reasoning: "整理关键点"},
	}
	turns := []plannerDisplayTurn{{
		TurnID:   "turn_1",
		UserHash: messageDisplayKey(agent.UserMessageText(host)),
		Messages: planner,
	}}

	state := newHistoryMessageConvertState(turns)
	rows := state.convertHistoryMessage(0, host, func(v string) string { return v }, nil, nil, nil)

	if want := 1 + len(planner); len(rows) != want {
		t.Fatalf("行数 = %d，期望 %d（1 条宿主 + %d 条 planner）", len(rows), want, len(planner))
	}

	seen := map[string]int{}
	for i, row := range rows {
		seen[row.ID]++
		t.Logf("row[%d] id=%q role=%q contentLen=%d", i, row.ID, row.Role, len(row.Content))
	}

	if seen[host.ID] == len(rows) {
		t.Fatalf("%d 行全部共用宿主 ID %q：planner 行没有自己的身份，前端按 messageID 合并会丢行", len(rows), host.ID)
	}
	if len(seen) != len(rows) {
		t.Fatalf("ID 去重后只剩 %d 个（行数 %d）：%v", len(seen), len(rows), seen)
	}
}
