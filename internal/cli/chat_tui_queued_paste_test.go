package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"reasonix/internal/control"
	"reasonix/internal/event"
)

func TestQueuedFoldedPasteExpandsBeforeInterjectSend(t *testing.T) {
	runner := &recordingTurnRunner{}
	events := make(chan event.Event, 8)
	dir := t.TempDir()
	var ctrl *control.Controller
	ctrl = control.New(control.Options{
		Runner: runner,
		Sink: event.FuncSink(func(e event.Event) {
			if e.Kind == event.TurnDone {
				// Seal admission before delivery so the completion tail cannot reopen
				// the durable inbox while this test removes its session directory.
				ctrl.Close()
			}
			events <- e
		}),
		SessionDir: dir,
		Label:      "test",
	})
	// Close first, then wait for SessionDir to go quiet: Close() does not join
	// background writers (autosave, inbox retry, coalesced event flush), so
	// t.TempDir() cleanup would race a late write on slow -race CI machines.
	defer func() {
		ctrl.Close()
		waitForSessionQuiet(t, dir)
	}()
	ctrl.EnsureSessionPath()
	m := newTestChatTUI()
	m.ctrl = &busyInboxController{SessionAPI: ctrl}
	m.eventCh = make(chan event.Event, 8)
	m.state = tuiRunning
	pasted := strings.Repeat("queued pasted content\n", 10)
	model, _ := m.Update(tea.PasteMsg{Content: pasted})
	m = model.(chatTUI)

	display := strings.TrimSpace(m.input.Value())
	if !strings.Contains(display, "[Pasted text #1") {
		t.Fatalf("paste should be folded, got %q", display)
	}

	model, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = model.(chatTUI)

	bodies := m.inboxBodies()
	if len(bodies) != 1 {
		t.Fatalf("queue should have 1 item, got %d", len(bodies))
	}
	queued := bodies[0]
	if queued == display {
		t.Fatalf("queued interject kept the folded placeholder: %q", queued)
	}
	for _, want := range []string{
		"queued pasted content",
		"--- Begin [Pasted text #1",
		"--- End [Pasted text #1",
	} {
		if !strings.Contains(queued, want) {
			t.Fatalf("queued interject missing %q in:\n%s", want, queued)
		}
	}

	// Resume inbox so controller can dispatch after TurnDone.
	_ = ctrl.SetInboxPaused(false)
	model, _ = m.Update(agentEventMsg(event.Event{Kind: event.TurnDone}))
	m = model.(chatTUI)
	// Wait for the completed dispatch with admission already sealed.
	waitForCLIEvent(t, events, event.TurnDone)

	if len(runner.inputs) != 1 {
		t.Fatalf("runner should receive queued interject, inputs=%q", runner.inputs)
	}
	sent := runner.inputs[0]
	if sent == display {
		t.Fatalf("runner received the folded placeholder: %q", sent)
	}
	if !strings.Contains(sent, "queued pasted content") {
		t.Fatalf("runner input missing pasted content:\n%s", sent)
	}
}

// waitForSessionQuiet waits until the session directory stops changing.
// Close() does not join background writers touching SessionDir (= t.TempDir()),
// so t.TempDir() cleanup races a late write on slow -race CI machines.
func waitForSessionQuiet(t *testing.T, dir string) {
	t.Helper()
	prev := ""
	deadline := time.Now().Add(15 * time.Second)
	for quiet := 0; quiet < 60; {
		time.Sleep(5 * time.Millisecond)
		var sb strings.Builder
		_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			// Fingerprint size and mtime too: a writer appending to an existing
			// file changes neither the path list nor the file count, so a
			// path-only check would call the directory quiet too early.
			sb.WriteString(p)
			if info != nil {
				fmt.Fprintf(&sb, "|%d|%d", info.Size(), info.ModTime().UnixNano())
			}
			return nil
		})
		if cur := sb.String(); cur != prev {
			quiet = 0
		} else {
			quiet++
		}
		prev = sb.String()
		if time.Now().After(deadline) {
			t.Fatalf("session directory did not become quiet: %s", dir)
		}
	}
}
