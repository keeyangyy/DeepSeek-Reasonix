package agent

import (
	"strings"
	"testing"

	"reasonix/internal/provider"
)

// 现场复现（2026-09-29「会话重复问题」实测）：reasoning 2.84M chars 的研究型
// 会话，冷启动无校准 → 旧 fallback 0.25×4.47M = 1.14M（UI 显示超 1M，实际
// 真实 lastPromptTokens 仅 412k）。412k / (4.47M−2.84M 文本) = 0.253，恰好
// 标准文本比率 → 重放 reasoning 发出去但不计费。修复后冷启动 fallback 剔除
// reasoning，估算即准。
func TestColdEstimateExcludesReplayedReasoning(t *testing.T) {
	a := estimateReproAgent() // 无校准，走冷启动 fallback
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: strings.Repeat("x", 300_000)},
		{Role: provider.RoleAssistant,
			ReasoningContent: strings.Repeat("r", 2_800_000),
			ToolCalls:        []provider.ToolCall{{ID: "call_1", Name: "bash", Arguments: `{"command":"ls"}`}}},
	}
	est := a.estimatedRequestTokens(provider.Request{Messages: msgs})
	// 非 reasoning 文本 ≈300k chars 按 0.25 ≈ 75k；2.8M reasoning 不计。
	if est > 100_000 {
		t.Fatalf("冷启动估算 %d 把 2.8M 重放 reasoning 按文本计价（真实该构成约 75k）", est)
	}
	if est < 60_000 {
		t.Fatalf("冷启动估算 %d 过低：300k 文本 chars 应按 0.25 计约 75k", est)
	}
}

// 校准态语义不变：带 tool_calls 的重放 reasoning 仍进校准分母（上游
// 65f0a7dd4 防低估超窗），ratio 自适应后估算自洽——只有冷启动 fallback 剔除。
// 构成与现场一致（reasoning 占比 ~63%，ratio≈0.09 高于 0.05 下限）。
func TestCalibratedRatioStillCountsReplayChars(t *testing.T) {
	a := estimateReproAgent()
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: strings.Repeat("x", 900_000)},
		{Role: provider.RoleAssistant,
			ReasoningContent: strings.Repeat("r", 2_840_000),
			ToolCalls:        []provider.ToolCall{{ID: "call_1", Name: "bash", Arguments: `{"command":"ls"}`}}},
		{Role: provider.RoleTool, Content: strings.Repeat("y", 690_000), ToolCallID: "call_1", Name: "bash"},
	}
	req := provider.Request{Messages: msgs}
	shape := a.requestCalibrationShape(req)
	if shape.reasoningChars != 2_840_000 {
		t.Fatalf("shape.reasoningChars = %d, want 2840000", shape.reasoningChars)
	}
	// 校准样本 = 同构成请求的实测 412k（现场 lastPromptTokens）。
	a.setPromptTokenCalibration(412_000, shape)
	if got := a.estimatedRequestTokens(req); got < 350_000 || got > 470_000 {
		t.Fatalf("校准态估算 %d 偏离实测 412k 超过容差", got)
	}
}
