package main

// Reproduction cases for "switching back occasionally fails with a lease
// error": the target still has a starting or dead detached copy that blocks the
// switch. T1/T3 fail before the fix; T2 guards a foreign holder is never reclaimed.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/control"
)

// T1: switch back while the detached copy is still starting. Today this fails
// immediately; it must wait for the copy to become ready and attach it.
func TestRebindWaitsForStartingDetachedTarget(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := globalTabWorkspaceRoot()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir session dir: %v", err)
	}

	sourcePath := filepath.Join(dir, "wait-source.jsonl")
	targetPath := filepath.Join(dir, "wait-target.jsonl")
	writeHistoryTestSession(t, sourcePath, "source prompt")
	writeHistoryTestSession(t, targetPath, "target prompt")
	loaded, err := agent.LoadSession(targetPath)
	if err != nil {
		t.Fatalf("load target: %v", err)
	}

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}

	sourceRunner := &blockingRunner{started: make(chan struct{}), release: make(chan struct{})}
	sourceSink := &tabEventSink{tabID: "visible", app: app, ctx: app.ctx}
	targetSink := &tabEventSink{tabID: "detached", app: app}
	installNoopRuntimeEvents(app, sourceSink, targetSink)
	sourceCtrl := control.New(control.Options{
		Runner: sourceRunner, SessionDir: dir, SessionPath: sourcePath,
		Label: "source", Sink: sourceSink,
	})
	targetCtrl := control.New(control.Options{
		SessionDir: dir, SessionPath: targetPath, Label: "target", Sink: targetSink,
	})

	tab := &WorkspaceTab{
		ID: "visible", Scope: "global", WorkspaceRoot: root,
		SessionPath: sourcePath, Ctrl: sourceCtrl, Ready: true, sink: sourceSink,
		disabledMCP: map[string]ServerView{},
	}
	app.tabs[tab.ID] = tab
	app.tabOrder = []string{tab.ID}
	app.activeTabID = tab.ID
	if err := tab.ensureSessionLease(sourcePath); err != nil {
		t.Fatalf("lease source: %v", err)
	}
	app.mu.Lock()
	app.newSessionRuntimeLocked(tab, sessionRuntimeKey(sourcePath))
	app.advanceSessionRuntimeEpochLocked(tab)
	app.mu.Unlock()

	targetLease, err := agent.TryAcquireSessionLease(targetPath)
	if err != nil {
		t.Fatalf("lease target: %v", err)
	}
	targetKey := sessionRuntimeKey(targetPath)
	detachedTarget := &WorkspaceTab{
		ID: detachedRuntimeTabID(targetKey), Scope: "global", WorkspaceRoot: root,
		SessionPath: targetPath, Ctrl: targetCtrl, Ready: true, sink: targetSink,
		disabledMCP: map[string]ServerView{},
	}
	detachedTarget.adoptSessionLease(targetLease)
	app.mu.Lock()
	app.detachedSessions[targetKey] = detachedTarget
	app.newSessionRuntimeLocked(detachedTarget, targetKey)
	app.advanceSessionRuntimeEpochLocked(detachedTarget)
	// The copy is still starting: no usable runtime has been published yet.
	app.setSessionRuntimePhaseLocked(detachedTarget, sessionRuntimeStarting, nil)
	app.mu.Unlock()

	sourceReleased := false
	t.Cleanup(func() {
		if !sourceReleased {
			close(sourceRunner.release)
		}
		sourceCtrl.Close()
		targetCtrl.Close()
		tab.releaseSessionLease()
		app.mu.RLock()
		stillDetached := app.detachedSessions[targetKey]
		app.mu.RUnlock()
		if stillDetached != nil {
			stillDetached.releaseSessionLease()
		}
	})

	sourceCtrl.Submit("keep source running")
	select {
	case <-sourceRunner.started:
	case <-time.After(5 * time.Second):
		t.Fatal("source turn did not start")
	}

	// The detached copy finishes starting shortly after the user clicks back.
	go func() {
		time.Sleep(200 * time.Millisecond)
		app.mu.Lock()
		if app.detachedSessions[targetKey] == detachedTarget {
			app.setSessionRuntimePhaseLocked(detachedTarget, sessionRuntimeReady, nil)
		}
		app.mu.Unlock()
	}()

	started := time.Now()
	err = app.rebindTabToLoadedSessionPath(tab, targetPath, loaded)
	t.Logf("switch-back while the copy was starting: err=%v after %v", err, time.Since(started))
	if err != nil {
		t.Fatalf("switching back must wait for the starting copy and attach it, got: %v", err)
	}
	if tab.Ctrl != targetCtrl {
		t.Fatalf("target runtime = ctrl %p, want %p", tab.Ctrl, targetCtrl)
	}
	app.mu.RLock()
	leftover := app.detachedSessions[targetKey]
	app.mu.RUnlock()
	if leftover != nil {
		t.Fatalf("target stayed detached after attach: %#v", leftover)
	}

	close(sourceRunner.release)
	sourceReleased = true
	waitNotRunning(t, sourceCtrl)
}

// T3: the target still has a detached entry whose controller is already gone.
// Today the switch is refused by that stale local runtime; it must be dropped.
func TestRebindDropsDeadDetachedRuntimeInsteadOfRefusing(t *testing.T) {
	isolateDesktopUserDirs(t)
	root := globalTabWorkspaceRoot()
	dir := desktopSessionDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir session dir: %v", err)
	}

	sourcePath := filepath.Join(dir, "dead-source.jsonl")
	targetPath := filepath.Join(dir, "dead-target.jsonl")
	writeHistoryTestSession(t, sourcePath, "source prompt")
	writeHistoryTestSession(t, targetPath, "target prompt")
	loaded, err := agent.LoadSession(targetPath)
	if err != nil {
		t.Fatalf("load target: %v", err)
	}

	app := NewApp()
	app.ctx = context.Background()
	app.readyHook = func() {}

	sourceSink := &tabEventSink{tabID: "visible", app: app, ctx: app.ctx}
	targetSink := &tabEventSink{tabID: "dead", app: app}
	installNoopRuntimeEvents(app, sourceSink, targetSink)

	tab := &WorkspaceTab{
		ID: "visible", Scope: "global", WorkspaceRoot: root,
		SessionPath: sourcePath, sink: sourceSink,
		disabledMCP: map[string]ServerView{},
	}
	app.tabs[tab.ID] = tab
	app.tabOrder = []string{tab.ID}
	app.activeTabID = tab.ID
	if err := tab.ensureSessionLease(sourcePath); err != nil {
		t.Fatalf("lease source: %v", err)
	}

	targetKey := sessionRuntimeKey(targetPath)
	deadLease, err := agent.TryAcquireSessionLease(targetPath)
	if err != nil {
		t.Fatalf("lease target: %v", err)
	}
	dead := &WorkspaceTab{
		ID: detachedRuntimeTabID(targetKey), Scope: "global", WorkspaceRoot: root,
		SessionPath: targetPath, sink: targetSink,
		disabledMCP: map[string]ServerView{},
	}
	dead.adoptSessionLease(deadLease)
	app.mu.Lock()
	app.detachedSessions[targetKey] = dead
	app.newSessionRuntimeLocked(dead, targetKey)
	// The copy's controller is gone: its runtime is closing, Ctrl is nil.
	app.setSessionRuntimePhaseLocked(dead, sessionRuntimeClosing, nil)
	app.mu.Unlock()

	t.Cleanup(func() {
		tab.releaseSessionLease()
		app.mu.RLock()
		leftover := app.detachedSessions[targetKey]
		app.mu.RUnlock()
		if leftover != nil {
			leftover.releaseSessionLease()
		}
	})

	err = app.rebindTabToLoadedSessionPath(tab, targetPath, loaded)
	t.Logf("switch with a dead detached entry: err=%v", err)
	if err != nil && (errors.Is(err, agent.ErrSessionLeaseHeld) ||
		strings.Contains(err.Error(), "already open in another Reasonix window") ||
		strings.Contains(err.Error(), "local runtime already owns session")) {
		t.Fatalf("switch was refused by a dead local runtime: %v", err)
	}
	app.mu.RLock()
	survived := app.detachedSessions[targetKey]
	app.mu.RUnlock()
	if survived != nil {
		t.Fatalf("dead detached entry was not dropped: %#v", survived)
	}
}

// T2 (red line): a holder that is not this process is never reclaimed — the
// user must still get the fast, honest error instead of a hung UI.
func TestRebindDoesNotReclaimForeignLeaseHolder(t *testing.T) {
	isolateDesktopUserDirs(t)
	path := filepath.Join(t.TempDir(), "foreign.jsonl")

	app := NewApp()
	tab := &WorkspaceTab{ID: "opener", Scope: "global", SessionPath: path}
	foreign := &agent.SessionLeaseError{
		Path: path,
		Info: &agent.SessionLeaseInfo{PID: os.Getpid() + 1, WriterID: "another-host-999"},
	}
	if !errors.Is(foreign, agent.ErrSessionLeaseHeld) {
		t.Fatalf("fixture error is not ErrSessionLeaseHeld: %v", foreign)
	}
	if app.canReclaimCurrentProcessSessionLease(tab, path, foreign) {
		t.Fatal("a foreign holder must never be reclaimed by this process")
	}
}
