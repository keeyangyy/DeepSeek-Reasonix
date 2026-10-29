package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"reasonix/internal/tool"
)

// 回归：压缩过程中切换会话，压缩不应作废。
//
// 单标签页下“切换会话”不是多开，而是同一个 executor 换 session
// （controller.Resume 里的 SetSession）。压缩协程持有的是同一个 *Agent，
// 如果提交时拿「当前会话」去比对，切走就必然失配、整份摘要被丢弃——
// 用户的压缩投影因此不生效。压缩必须绑定它开始时的那个会话。
func TestCompactionSnapshotSurvivesSessionSwitch(t *testing.T) {
	mock := &loopMock{t: t}
	srv := httptest.NewServer(http.HandlerFunc(mock.handler))
	defer srv.Close()

	reg := tool.NewRegistry()
	reg.Add(fatTool{blob: strings.Repeat("LARGE FILE CONTENTS. ", 40)})
	a, _ := newAgent(t, srv.URL, reg, 200000, 4)

	// 会话 A 先有一轮真实历史。
	if err := a.Run(context.Background(), "turn 0: keep going"); err != nil {
		t.Fatalf("seed turn: %v", err)
	}

	// 压缩开始时拍下的快照（生产路径 compressVisibleRange 就是这么拍的）。
	snap := a.snapshotExplicitCompression()
	if !a.explicitCompressionSnapshotCurrent(snap) {
		t.Fatal("前提不成立：刚拍完的快照就无效")
	}

	// 切换到另一个会话：单标签页的真实动作。
	a.SetSession(NewSession("system prompt for session b"))

	// 修复后必须仍然有效：压缩绑定开始时的会话，切走不该让它作废。
	if !a.explicitCompressionSnapshotCurrent(snap) {
		t.Fatal("切走后快照被判失效：压缩结果会被整份丢弃（这正是要修的 bug）")
	}
}
