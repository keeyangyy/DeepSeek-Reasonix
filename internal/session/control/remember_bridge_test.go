package control

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"reasonix/internal/base/testenv"
	"reasonix/internal/contract/event"
	"reasonix/internal/state/memory"
)

func rememberReceipts(seen []event.Event) int {
	n := 0
	for _, e := range seen {
		if e.Kind == event.Notice && e.Code == event.NoticeCodeMemorySavedUnasked {
			n++
		}
	}
	return n
}

// TestTheSwitchLeavesAReceiptTheWritePays pins the receipt: the switch's
// decision marks the fact it let through, and only the write that reports that
// same fact, once, pays it — a different fact's save pays nothing, and a second
// report of the same name is not paid again.
func TestTheSwitchLeavesAReceiptTheWritePays(t *testing.T) {
	root := testenv.TempDir(t)
	store := memory.Store{Dir: filepath.Join(root, "project"), GlobalDir: filepath.Join(root, "global")}
	// A fact already stored under this name is what the low-risk path refuses
	// (an existing memory may cover it) and the switch answers, so the write
	// reaches the receipt rather than the low-risk path's own silent write.
	if _, err := store.Save(memory.Memory{
		Name: "release-target", Title: "Release target", Description: "Release target",
		Type: memory.TypeProject, Scope: memory.FactScopeProject, Body: "Release from main.",
	}); err != nil {
		t.Fatal(err)
	}
	var seen []event.Event
	c := &Controller{controllerDeps: controllerDeps{
		autoConfirmProjectRemember: true,
		sink:                       event.FuncSink(func(e event.Event) { seen = append(seen, e) }),
		memory:                     newMemoryManager(&memory.Set{Store: store}),
	}}
	args := json.RawMessage(`{"name":"release-target","scope":"project","description":"Release target","body":"Release from main-v2."}`)

	allow, _, _, err := gateApprover{c}.approveWithPolicyReason(context.Background(), memoryRememberTool, "", args, "")
	if err != nil || !allow {
		t.Fatalf("gate with the switch on = (allow=%v, err=%v)", allow, err)
	}
	if got := rememberReceipts(seen); got != 0 {
		t.Fatalf("a receipt was emitted before the write: %d", got)
	}
	c.QueueMemory("Saved memory \"release-target\" (project): Release target\nRelease from main-v2.")
	if got := rememberReceipts(seen); got != 1 {
		t.Fatalf("receipts after the write = %d, want 1", got)
	}
	// The mark is consumed: a second report of the same fact pays nothing.
	c.QueueMemory("Saved memory \"release-target\" (project): Release target")
	if got := rememberReceipts(seen); got != 1 {
		t.Fatalf("receipts after a second report = %d, want 1", got)
	}
	// A different fact's save is not this write's report.
	c.memory.markReceipt("release-target")
	c.QueueMemory("Saved memory \"other-fact\" (project): Another fact")
	if got := rememberReceipts(seen); got != 1 {
		t.Fatalf("receipts after an unrelated save = %d, want 1", got)
	}
}

// TestTheSwitchLeavesNoReceiptForSensitiveContent pins the two halves together:
// a write the content floor refuses never marks a receipt, so nothing is
// reported as saved-unasked when the dialog still stands in front of it.
func TestTheSwitchLeavesNoReceiptForSensitiveContent(t *testing.T) {
	root := testenv.TempDir(t)
	var seen []event.Event
	c := &Controller{controllerDeps: controllerDeps{
		autoConfirmProjectRemember: true,
		sink:                       event.FuncSink(func(e event.Event) { seen = append(seen, e) }),
		memory: newMemoryManager(&memory.Set{Store: memory.Store{
			Dir: filepath.Join(root, "project"), GlobalDir: filepath.Join(root, "global"),
		}}),
	}}
	secret := json.RawMessage(`{"name":"deploy-key","scope":"project","description":"Deploy","body":"DEPLOY_API_KEY=sk-example-secret-value-123456"}`)
	if got := c.allowRememberByScope(secret); got.AutoAllow {
		t.Fatalf("sensitive write passed on the switch: %+v", got)
	}
	if got := rememberReceipts(seen); got != 0 {
		t.Fatalf("a receipt was left for a write the switch refused: %d", got)
	}
}
