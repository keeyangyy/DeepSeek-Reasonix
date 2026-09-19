package control

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"reasonix/internal/event"
)

// TestReplayPendingPromptsDoesNotReappendToLedger — replay 重发的 AskRequest 只
// 发布不入账：同一 pending ask 经多次 ReplayPendingPrompts 后，ledger 里的
// ask_request 记录仍是原始一条。此前每次 tab 重连的 replay 都把重发的 gate
// 当作新事件入账（e18f1f8e 实证：一条 pending ask 连续入账 5 条 seq），后续
// turn replay 逐条重放 gate 且 replayed rebuild 与 live 行交错错位。
func TestReplayPendingPromptsDoesNotReappendToLedger(t *testing.T) {
	dir := t.TempDir()
	var askEmitMu sync.Mutex
	askEmits := 0
	release := make(chan struct{})
	releaseOnce := func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}
	c := New(Options{
		SessionDir: dir, SessionPath: filepath.Join(dir, "session.jsonl"),
		Sink: event.FuncSink(func(e event.Event) {
			if e.Kind == event.AskRequest {
				askEmitMu.Lock()
				askEmits++
				askEmitMu.Unlock()
			}
		}),
	})
	t.Cleanup(func() {
		releaseOnce()
		c.Cancel()
		waitIdle(t, c)
		c.Close()
	})
	c.SetTurnEventRoutingMetadata("runtime-ask", "")
	c.runGuarded(func(ctx context.Context) error {
		if _, err := c.Ask(ctx, askProbeQuestions()); err != nil {
			return err
		}
		<-release
		return nil
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		askEmitMu.Lock()
		emits := askEmits
		askEmitMu.Unlock()
		if emits >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Ask was not published")
		}
		time.Sleep(10 * time.Millisecond)
	}
	records, err := c.TurnEventsAfter(0)
	if err != nil {
		t.Fatalf("TurnEventsAfter: %v", err)
	}
	var firstAskID string
	for _, record := range records {
		if record.Kind == "ask_request" && firstAskID == "" {
			firstAskID = record.ItemID
		}
	}
	if firstAskID == "" {
		t.Fatal("original ask_request missing from the ledger")
	}

	countAsks := func() int {
		records, err := c.TurnEventsAfter(0)
		if err != nil {
			t.Fatalf("TurnEventsAfter: %v", err)
		}
		n := 0
		for _, record := range records {
			if record.Kind == "ask_request" {
				n++
			}
		}
		return n
	}
	if got := countAsks(); got != 1 {
		t.Fatalf("ask_request records after first emit = %d, want 1", got)
	}

	// 模拟切走再切回：多次 runtime attach + 前端 replayMissingPrompt 都会触发
	// ReplayPendingPrompts（日志实测同一 ask 触发 5 次）。
	for range 4 {
		c.ReplayPendingPrompts()
	}
	if got := countAsks(); got != 1 {
		t.Fatalf("ask_request records after 4 replays = %d, want exactly 1 (replay re-emissions must not append to the ledger)", got)
	}
}
