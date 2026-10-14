package provider

import "testing"

// 现场复现（2026-09-28 rx修复4）：商汤渠道对 4.1MB 压缩请求返回 400
// "inference request is invalid"，未被识别为上下文溢出 → observeSummaryOutcome
// 的学习分支跳过 → 同一 body 原样重发三次全挂（axonhub exec 121770-121778）。
// 修复后该文案（含 502 包装形态）应识别为无数字 ContextLimitError，让裁剪重试
// 生效；普通参数错误 400 不得误报。
func TestParseContextLimitErrorRecognizesSensenovaInvalid(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   bool
	}{
		{"sensenova 400 plain", 400, `inference request is invalid`, true},
		{"sensenova 400 json", 400, `{"error":{"message":"inference request is invalid"}}`, true},
		{"relay-wrapped 502", 502, `[400]: inference request is invalid`, true},
		{"case variance", 400, `Inference Request Is Invalid`, true},
		{"unrelated 400", 400, `some parameter validation failed`, false},
		{"unrelated 502", 502, `upstream unavailable`, false},
		{"tpm limit is not overflow", 429, `inference exceeds tpm/rpm limit`, false},
	}
	for _, tc := range cases {
		got := ParseContextLimitError(&APIError{Status: tc.status, Body: tc.body})
		if (got != nil) != tc.want {
			t.Fatalf("%s: ParseContextLimitError(status=%d, body=%q) = %v, want recognized=%v",
				tc.name, tc.status, tc.body, got, tc.want)
		}
	}
}

// 无数字溢出不得伪造校准数据：WindowTokens/PromptTokens 保持 0，调用方
// （observeSummaryOutcome）据此跳过校准与窗口学习，只走裁剪重试。
func TestUnnumberedOverflowCarriesNoFabricatedNumbers(t *testing.T) {
	got := ParseContextLimitError(&APIError{Status: 400, Body: `inference request is invalid`})
	if got == nil {
		t.Fatal("expected unnumbered context limit error")
	}
	if got.WindowTokens != 0 || got.PromptTokens != 0 || got.RequestedTokens != 0 {
		t.Fatalf("unnumbered overflow must not fabricate numbers: %+v", got)
	}
}
