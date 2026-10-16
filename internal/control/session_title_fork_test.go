package control

import (
	"context"
	"reasonix/internal/event"
	"strings"
	"testing"
)

// 推理模型的隐藏推理计入 completion 预算：标题预算必须给足推理余量，
// 否则推理占满 MaxTokens、最终输出为空，AI 重命名报"空标题"（上游实测
// 512 token 全推理）。断言请求携带 16k 的预算。
func TestGenerateSessionTitleLeavesReasoningHeadroom(t *testing.T) {
	prov := &sessionTitleProviderStub{out: "标题"}
	ctrl := sessionTitleTestController(prov, event.Discard)
	if _, err := ctrl.GenerateSessionTitle(context.Background(), "User: 一句话总结"); err != nil {
		t.Fatalf("GenerateSessionTitle: %v", err)
	}
	if got := prov.requests[0].MaxTokens; got != sessionTitleMaxTokens {
		t.Fatalf("MaxTokens = %d, want %d (reasoning tokens share the completion budget)", got, sessionTitleMaxTokens)
	}
}

// 预算耗尽仍拿不到标题时，错误必须指向推理占满，而不是含糊的"空标题"。
func TestGenerateSessionTitleEmptyOutputMentionsReasoningBudget(t *testing.T) {
	prov := &sessionTitleProviderStub{reasoning: "思考内容", finishReason: "length"}
	ctrl := sessionTitleTestController(prov, event.Discard)
	_, err := ctrl.GenerateSessionTitle(context.Background(), "User: 一句话总结")
	if err == nil {
		t.Fatal("empty output should fail")
	}
	if !strings.Contains(err.Error(), "reasoning") {
		t.Fatalf("error = %v, want reasoning-budget hint", err)
	}
}
