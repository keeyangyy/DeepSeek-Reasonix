package control

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reasonix/internal/event"
	"reasonix/internal/sessioninbox"
)

// 缺陷 1 回归：接受 steer → 退回队列 → 回合结束，项必须仍是 queued，
// 不能被 AckDequeue 判成 uncertain，也不能暂停整个队列。
func TestReleasedItemSurvivesTurnDone(t *testing.T) {
	dir := t.TempDir()
	done := make(chan struct{}, 4)
	runner := &gatedInboxDispatchRunner{
		inputs:       make(chan string, 8),
		firstStarted: make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}
	c := New(Options{
		Runner: runner,
		Sink: event.FuncSink(func(e event.Event) {
			if e.Kind == event.TurnDone {
				select {
				case done <- struct{}{}:
				default:
				}
			}
		}),
		SessionDir:  dir,
		SessionPath: filepath.Join(dir, "session.jsonl"),
	})
	t.Cleanup(func() {
		c.Close()
		c.autosaveWG.Wait()
	})

	rec, err := c.EnqueueInbox(InboxRequest{Intent: sessioninbox.IntentFollowup, Submit: "退回测试"})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	c.maybeDispatchInbox()

	// 等这一轮跑起来
	select {
	case <-runner.firstStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("turn did not start")
	}

	// 模拟"插入本轮"：把项标成 steer_accepted 并纳入 active 追踪。
	st, err := c.ensureInbox()
	if err != nil {
		t.Fatalf("ensureInbox: %v", err)
	}
	if err := st.AcceptSteer(rec.ItemID); err != nil {
		t.Fatalf("AcceptSteer: %v", err)
	}
	c.inbox.mu.Lock()
	c.inbox.trackActive(rec.ItemID)
	activeAfterAccept := len(c.inbox.activeIDs())
	c.inbox.mu.Unlock()
	t.Logf("插入本轮后: state=steer_accepted activeIDs=%d", activeAfterAccept)

	// 模拟"退回队列"
	if err := c.ReleaseInboxItem(rec.ItemID); err != nil {
		t.Fatalf("ReleaseInboxItem: %v", err)
	}
	c.inbox.mu.Lock()
	activeAfterRelease := len(c.inbox.activeIDs())
	c.inbox.mu.Unlock()
	snap := st.Snapshot()
	stateAfterRelease := ""
	for _, it := range snap.Items {
		if it.ID == rec.ItemID {
			stateAfterRelease = string(it.State)
		}
	}
	t.Logf("退回队列后: state=%s activeIDs=%d", stateAfterRelease, activeAfterRelease)

	// 结束这一轮，触发 onInboxTurnDone 的 ack 清扫
	close(runner.releaseFirst)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("turn did not finish")
	}

	// 退回的项应该作为下一轮被自动派发（这正是"会话结束自动发一条"）。
	var dispatchedNext string
	select {
	case dispatchedNext = <-runner.inputs:
	case <-time.After(5 * time.Second):
		dispatchedNext = ""
	}
	time.Sleep(300 * time.Millisecond)

	final := st.Snapshot()
	stateAfterDone := ""
	for _, it := range final.Items {
		if it.ID == rec.ItemID {
			stateAfterDone = string(it.State)
		}
	}
	t.Logf("回合结束后: 二次派发=%q state=%q paused=%v items=%d", dispatchedNext, stateAfterDone, final.Paused, len(final.Items))

	if activeAfterRelease != 0 {
		t.Errorf("退回后 activeIDs 应为 0，实际 %d —— untrackActive 没生效", activeAfterRelease)
	}
	if stateAfterDone == string(sessioninbox.StateUncertain) {
		t.Errorf("项被误判成 uncertain —— 缺陷 1 未修复")
	}
	if final.Paused {
		t.Error("回合结束后队列不应被暂停")
	}
	if dispatchedNext == "" {
		t.Error("退回的项应在下一轮自动派发，实际没有派发")
	} else if !strings.Contains(dispatchedNext, "退回测试") {
		t.Errorf("派发内容不含原消息，实际 %q", dispatchedNext)
	}
}
