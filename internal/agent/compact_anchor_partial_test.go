package agent

import (
	"fmt"
	"testing"

	"reasonix/internal/provider"
)

// 压缩只折叠会话前缀时，锚点必须按折叠到的位置算。
//
// 用 len(canonical) 会让锚点恒等于「压缩那一刻的总轮数」，卡片因此被推到会话
// 末尾——线上写入 60、而真实分界在第 47 轮之后，就是这样产生的。分界 id 与
// 锚点必须来自同一个 covered，否则前端拿到的两个坐标互相矛盾。
func TestCompactionAnchorUsesTheFoldedPrefixNotTheWholeTranscript(t *testing.T) {
	var msgs []provider.Message
	for i := 0; i < 60; i++ {
		msgs = append(msgs,
			provider.Message{ID: fmt.Sprintf("u%d", i), Role: provider.RoleUser, Content: "q"},
			provider.Message{ID: fmt.Sprintf("a%d", i), Role: provider.RoleAssistant, Content: "a"},
		)
	}
	covered := 47 * 2 // 折叠前 47 轮（每轮 user + assistant）

	if got := countCompactionAnchorUsers(msgs, covered); got != 47 {
		t.Fatalf("anchor over the folded prefix = %d, want 47", got)
	}
	if got := countCompactionAnchorUsers(msgs, len(msgs)); got != 60 {
		t.Fatalf("anchor over the whole transcript = %d, want 60", got)
	}
	boundary := msgs[covered-1].ID
	if got := lastCompactedMessageID(msgs, covered); got != boundary {
		t.Fatalf("boundary id = %q, want the last folded message %q", got, boundary)
	}
	if lastCompactedMessageID(msgs, len(msgs)) == boundary {
		t.Fatal("whole-transcript boundary must differ from the folded one in this fixture")
	}
}
