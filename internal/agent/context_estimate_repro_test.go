package agent

import (
	"encoding/json"
	"strings"
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
)

// 现场复现（2026-09-28 rx修复4）：估算 source_tokens=1,928,592 vs provider 实测
// prompt_tokens 封顶 798,985（2.4x 虚高），并伴随“切会话后估算失准”。
// 三个失真源分开复现：图片 token 混进文本比率、固定开销随会话放大、校准跨会话污染。

func estimateReproAgent() *Agent {
	return &Agent{
		agentConfig: agentConfig{contextWindow: 1_048_576},
		svc:         agentServices{prov: &sharedWindowTestProvider{}, sink: event.Discard},
		sess:        sessionRuntime{},
	}
}

// 复现 1：图片的视觉 token 进了 promptTokens（分子），base64 字符却不进
// requestChars（分母），把文本比率整体抬高；后续无图请求按被污染的比率
// 估算即虚高。修复后图片按张单列计价，比率只学文本。
func TestEstimateImageNotPricedAsText(t *testing.T) {
	a := estimateReproAgent()
	// 校准样本：文本 200k 字符（真实 45k tokens，0.225/char）+ 5 张图（按张计价
	// 5×visionTokensPerImageEstimate，base64 字符不进 requestChars）。
	a.setPromptTokenCalibration(45_000+5*visionTokensPerImageEstimate, requestCalibrationShape{
		requestChars: 200_000,
		compactChars: 190_000,
		imageCount:   5,
	})

	// 待估：同文本构成的纯文本请求 1M 字符，真实 225k tokens。
	msgs := []provider.Message{{Role: provider.RoleUser, Content: strings.Repeat("x", 1_000_000)}}
	est := a.estimatedRequestTokens(provider.Request{Messages: msgs})
	const real = 225_000
	if est > real*11/10 {
		t.Fatalf("纯文本请求估算 %d 超过真实 %d 的 1.1 倍：图片 token 混进了文本比率", est, real)
	}

	// 含 3 张同图的请求应显式加回图片 token（按张计价，不再吃字符比率）。
	withImg := []provider.Message{{
		Role:    provider.RoleUser,
		Content: strings.Repeat("x", 1_000_000),
		Images: []string{
			"data:image/png;base64," + strings.Repeat("A", 500_000),
			"data:image/png;base64," + strings.Repeat("B", 500_000),
			"data:image/png;base64," + strings.Repeat("C", 500_000),
		},
	}}
	estImg := a.estimatedRequestTokens(provider.Request{Messages: withImg})
	if estImg < est {
		t.Fatalf("含图请求估算 %d 反而低于纯文本 %d：图片 token 未被计价", estImg, est)
	}
	if estImg-est > 3*visionTokensPerImageEstimate*3/2 {
		t.Fatalf("3 张图的增量 %d 超过按张计价上限 %d：图片又在吃字符比率",
			estImg-est, 3*visionTokensPerImageEstimate*3/2)
	}
}

// 复现 2：真实计费是 tokens = A + B×chars（A = tools schema + system 等固定
// 开销），旧估算过原点用 ratio×chars，比率把 A 摊进字符，外推到长会话时误差
// = A×(放大倍数−1) 随会话线性放大。修复后固定开销单列。
func TestFixedOverheadDoesNotScaleWithSession(t *testing.T) {
	a := estimateReproAgent()
	// 校准样本：小请求 100k 字符 = tools/system 固定开销 40k 字符（真实 10k
	// tokens，英文 schema ≈4 char/token）+ 文本 60k 字符（真实 8k tokens，
	// 0.133/char 的转义 JSON 形态）。实测 promptTokens = 18k。
	a.setPromptTokenCalibration(18_000, requestCalibrationShape{
		requestChars:   100_000,
		compactChars:   60_000,
		overheadChars:  40_000,
		overheadTokens: 10_000,
	})

	// 待估：长会话请求 = 同一份 tools/system（固定 40k 字符 / 10k tokens）+
	// 文本 960k 字符（真实 0.133×960k ≈ 128k）。真实 ≈ 138k。
	schema := strings.Repeat("s", 40_000)
	msgs := []provider.Message{{Role: provider.RoleUser, Content: strings.Repeat("x", 960_000)}}
	est := a.estimatedRequestTokens(provider.Request{
		Messages: msgs,
		Tools:    []provider.ToolSchema{{Name: "tool", Description: schema, Parameters: json.RawMessage("{}")}},
	})
	const real = 138_000
	if est > real*11/10 {
		t.Fatalf("长会话估算 %d 超过真实 %d 的 1.1 倍：固定开销被摊进字符比率随会话放大", est, real)
	}
}

// 复现 3：promptCalibration 是 model 级一份且跨会话共享，B 会话的请求形状会
// 覆盖 A 的校准，切回 A 后估算用错比率（实测现象：切几个会话回来就不准）。
// 修复后校准随会话走。
func TestPromptCalibrationScopedToSession(t *testing.T) {
	a := estimateReproAgent()
	// 会话 A：中文密集，真实比率 0.33。
	a.SetSession(NewSession(""))
	a.SetSessionPath("session-a")
	a.setPromptTokenCalibration(33_000, requestCalibrationShape{requestChars: 100_000, compactChars: 95_000})

	// 会话 B：JSON/英文密集，真实比率 0.15，校准覆盖了全局。
	a.SetSession(NewSession(""))
	a.SetSessionPath("session-b")
	a.setPromptTokenCalibration(30_000, requestCalibrationShape{requestChars: 200_000, compactChars: 190_000})

	// 切回 A：估算 A 的 300k 字符请求，真实 = 300k×0.33 = 99k tokens。
	a.SetSession(NewSession(""))
	a.SetSessionPath("session-a")
	msgs := []provider.Message{{Role: provider.RoleUser, Content: strings.Repeat("x", 300_000)}}
	est := a.estimatedRequestTokens(provider.Request{Messages: msgs})
	const real = 99_000
	if est > real*11/10 || est < real*9/10 {
		t.Fatalf("切回会话 A 后估算 %d 偏离真实 %d 超过 ±10%%：校准被会话 B 污染", est, real)
	}
}
