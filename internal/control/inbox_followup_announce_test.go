package control

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"reasonix/internal/event"
	"reasonix/internal/sessioninbox"
)

// 队列里的 followup 被派发成新 turn 时，前端需要拿到提示原文才能画出 user
// 气泡。steer 有专门的 event.Steer 承担这件事；本测试固定 followup 路径同样
// 必须有事件携带文本，否则前端只能等重新加载会话才看得到。
func TestFollowupDispatchAnnouncesPromptText(t *testing.T) {
	dir := t.TempDir()

	var mu sync.Mutex
	type seen struct {
		kind event.Kind
		text string
	}
	var events []seen

	runner := &gatedInboxDispatchRunner{
		inputs:       make(chan string, 8),
		firstStarted: make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}

	c := New(Options{
		Runner: runner,
		Sink: event.FuncSink(func(e event.Event) {
			mu.Lock()
			events = append(events, seen{kind: e.Kind, text: e.Text})
			mu.Unlock()
		}),
		SessionDir:  dir,
		SessionPath: filepath.Join(dir, "session.jsonl"),
	})
	t.Cleanup(func() {
		c.Close()
		c.autosaveWG.Wait()
	})

	const prompt = "队列里写的话"
	if _, err := c.EnqueueInbox(InboxRequest{Intent: sessioninbox.IntentFollowup, Submit: prompt}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	c.maybeDispatchInbox()

	select {
	case <-runner.inputs:
	case <-time.After(5 * time.Second):
		t.Fatal("followup 没有被派发")
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	collected := append([]seen(nil), events...)
	mu.Unlock()

	for _, e := range collected {
		t.Logf("事件 kind=%v text=%q", e.kind, e.text)
	}

	for _, e := range collected {
		if e.text == prompt {
			return
		}
	}
	t.Fatalf("派发 followup 时没有任何事件携带提示原文 %q（共 %d 个事件），前端无法渲染 user 气泡", prompt, len(collected))
}
