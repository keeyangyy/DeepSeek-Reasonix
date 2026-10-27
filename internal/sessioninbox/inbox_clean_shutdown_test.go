package sessioninbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/store"
)

// 缺陷 2 回归：正常退出后重启，队列不应被冻结；崩溃后重启才需要暂停待查。

func newInboxSession(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// simulateRestart rewrites runId so the next Open sees a different process.
func simulateRestart(t *testing.T, session string) {
	t.Helper()
	manPath := filepath.Join(store.SessionInboxDir(session), "manifest.json")
	data, err := os.ReadFile(manPath)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	next := strings.Replace(string(data), ProcessRunID(), "simulated-next-run", 1)
	if err := os.WriteFile(manPath, []byte(next), 0o600); err != nil {
		t.Fatalf("rewrite manifest: %v", err)
	}
}

// 正常退出：标记干净退出 → 重启后队列保持可派发。
func TestCleanShutdownKeepsQueueDispatchable(t *testing.T) {
	session := newInboxSession(t)

	s, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := s.Enqueue(EnqueueRequest{Intent: IntentFollowup, Envelope: PromptEnvelope{SubmitText: "排队中的活"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MarkCleanShutdown(); err != nil {
		t.Fatalf("MarkCleanShutdown: %v", err)
	}
	s.Close()

	simulateRestart(t, session)

	s2, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	snap := s2.Snapshot()
	t.Logf("正常退出重启后: paused=%v recovered=%v items=%d", snap.Paused, snap.Recovered, len(snap.Items))

	if snap.Paused {
		t.Error("正常退出重启后队列不应被暂停")
	}
	if snap.Recovered {
		t.Error("正常退出重启后不应标记为 recovered")
	}
	if len(snap.Items) != 1 || snap.Items[0].State != StateQueued {
		t.Errorf("排队项应原样保留为 queued，实际 %+v", snap.Items)
	}
	if next, ok := s2.NextQueued(); !ok || next.ID != rec.ItemID {
		t.Errorf("重启后应能继续派发该队列项，实际 ok=%v next=%+v", ok, next)
	}
}

// 崩溃：没有干净退出标记 → 重启后仍暂停待查。
func TestCrashStillPausesQueue(t *testing.T) {
	session := newInboxSession(t)

	s, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Enqueue(EnqueueRequest{Intent: IntentFollowup, Envelope: PromptEnvelope{SubmitText: "崩溃前的活"}}); err != nil {
		t.Fatal(err)
	}
	// 故意不调用 MarkCleanShutdown，模拟进程被杀死
	s.Close()

	simulateRestart(t, session)

	s2, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	snap := s2.Snapshot()
	t.Logf("崩溃重启后: paused=%v recovered=%v recoveredN=%d items=%d", snap.Paused, snap.Recovered, snap.RecoveredN, len(snap.Items))

	if !snap.Paused || !snap.Recovered {
		t.Error("崩溃重启后队列应暂停并标记 recovered")
	}
	if snap.RecoveredN != 1 {
		t.Errorf("recoveredN 应为 1，实际 %d", snap.RecoveredN)
	}
	if next, ok := s2.NextQueued(); ok {
		t.Errorf("暂停状态下不应派发，却拿到 %+v", next)
	}
}

// 正常退出后不应把 in-flight 行悄悄放行：那是真的中断，仍要待查。
func TestCleanShutdownStillFlagsInFlight(t *testing.T) {
	session := newInboxSession(t)

	s, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := s.Enqueue(EnqueueRequest{Intent: IntentFollowup, Envelope: PromptEnvelope{SubmitText: "跑到一半的活"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetState(rec.ItemID, StateRunning, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkCleanShutdown(); err != nil {
		t.Fatalf("MarkCleanShutdown: %v", err)
	}
	s.Close()

	simulateRestart(t, session)

	s2, err := Open(session, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	snap := s2.Snapshot()
	t.Logf("干净退出但仍有 in-flight: paused=%v recovered=%v items=%+v", snap.Paused, snap.Recovered, snap.Items)

	if !snap.Paused {
		t.Error("in-flight 行在重启后必须暂停待查，不能被当成干净退出放行")
	}
	if len(snap.Items) != 1 || snap.Items[0].State != StateUncertain {
		t.Errorf("in-flight 行应转 uncertain，实际 %+v", snap.Items)
	}
}
