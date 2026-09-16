package main

import (
	"context"
	"log/slog"
	"time"

	"reasonix/internal/event"
)

// sessionOpenWaitTimeout bounds how long opening a conversation waits for its
// own not-yet-ready detached runtime. Overridable in tests.
var sessionOpenWaitTimeout = 8 * time.Second

// sessionOpenWaitPollInterval is how often the wait re-checks the runtime phase.
var sessionOpenWaitPollInterval = 50 * time.Millisecond

// awaitOwnedSessionRuntime reconciles the target session's own background
// runtime before a switch enters the rebuild barrier (never while holding
// runtimeRebuildMu). A still-starting copy is waited for; a copy whose
// controller is already gone is dropped so the switch can rebuild; a session
// with no local copy — including a foreign holder — returns immediately.
func (a *App) awaitOwnedSessionRuntime(tab *WorkspaceTab, sessionPath string) {
	key := sessionRuntimeKey(sessionPath)
	if key == "" {
		return
	}
	if a.sessionOpenWaitsForOwnRuntime(key) {
		if tab != nil {
			a.notifySessionTakeover(tab.ID)
		}
		_ = a.waitForDetachedRuntimeAttachable(key, sessionOpenWaitTimeout)
		return
	}
	if a.dropDeadOwnedSessionRuntime(key) {
		slog.Info("desktop: dropped a detached session runtime whose controller was gone")
	}
}

// sessionOpenWaitsForOwnRuntime reports whether opening this session must wait
// for a local detached copy that is still starting.
func (a *App) sessionOpenWaitsForOwnRuntime(key string) bool {
	if key == "" {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	detached := a.detachedSessions[key]
	if detached == nil {
		return false
	}
	if rt := a.runtimeForTabLocked(detached); rt != nil {
		return rt.Phase == sessionRuntimeStarting
	}
	return detached.Ctrl != nil && !detached.Ready
}

// detachedRuntimeAttachableLocked mirrors the readiness rule used by
// reattachDetachedSessionRuntimeForRebind: a detached copy is attachable only
// once it published a ready runtime (or reports Ready). Keep both in sync.
func (a *App) detachedRuntimeAttachableLocked(key string) bool {
	if key == "" {
		return false
	}
	detached := a.detachedSessions[key]
	if detached == nil || detached.Ctrl == nil {
		return false
	}
	if rt := a.runtimeForTabLocked(detached); rt != nil {
		return rt.Phase == sessionRuntimeReady
	}
	return detached.Ready
}

// dropDeadOwnedSessionRuntime removes a detached copy that can never be
// attached (its controller is gone, or its runtime already closed or failed)
// and releases the stale lease it left behind, so the switch is not refused by
// a runtime nobody owns. Returns true when an entry was dropped.
func (a *App) dropDeadOwnedSessionRuntime(key string) bool {
	a.mu.Lock()
	detached := a.detachedSessions[key]
	if detached == nil {
		a.mu.Unlock()
		return false
	}
	rt := a.runtimeForTabLocked(detached)
	dead := false
	switch {
	case rt == nil:
		dead = detached.Ctrl == nil
	case rt.Phase == sessionRuntimeClosing,
		rt.Phase == sessionRuntimeFailed,
		rt.Phase == sessionRuntimeLeaseBlocked:
		dead = true
	}
	if !dead {
		a.mu.Unlock()
		return false
	}
	delete(a.detachedSessions, key)
	if rt != nil {
		a.removeSessionRuntimeMappingsLocked(rt)
	}
	a.mu.Unlock()
	detached.releaseSessionLease()
	return true
}

// waitForDetachedRuntimeAttachable waits for the session's own detached runtime
// to become attachable. It holds no App.mu while sleeping and gives up at the
// deadline or when the app shuts down. Returns true once attachable.
func (a *App) waitForDetachedRuntimeAttachable(key string, timeout time.Duration) bool {
	if key == "" || timeout <= 0 {
		return false
	}
	a.mu.RLock()
	attachable := a.detachedRuntimeAttachableLocked(key)
	a.mu.RUnlock()
	if attachable {
		return true
	}
	started := time.Now()
	deadline := started.Add(timeout)
	for {
		if !sleepForSessionOpen(sessionOpenWaitPollInterval, a.bootContext()) {
			return false
		}
		a.mu.RLock()
		detached := a.detachedSessions[key]
		a.mu.RUnlock()
		if detached == nil {
			return false
		}
		a.mu.RLock()
		attachable = a.detachedRuntimeAttachableLocked(key)
		a.mu.RUnlock()
		if attachable {
			slog.Info("desktop: session runtime became attachable after waiting",
				"waited_ms", time.Since(started).Milliseconds())
			return true
		}
		if time.Now().After(deadline) {
			slog.Warn("desktop: session runtime still not attachable after waiting",
				"waited_ms", time.Since(started).Milliseconds())
			return false
		}
	}
}

// sleepForSessionOpen sleeps for d, returning false if the app context ended.
func sleepForSessionOpen(d time.Duration, ctx context.Context) bool {
	if ctx == nil {
		time.Sleep(d)
		return true
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// notifySessionTakeover tells the tab's UI that opening the conversation is
// waiting for its own background runtime, so a delayed switch never looks like
// a freeze. It only emits an informational notice.
func (a *App) notifySessionTakeover(tabID string) {
	a.mu.RLock()
	tab := a.tabs[tabID]
	a.mu.RUnlock()
	if tab == nil || tab.sink == nil {
		return
	}
	tab.sink.Emit(event.Event{
		Kind:  event.Notice,
		Level: event.LevelInfo,
		Text:  "正在接管会话…",
	})
}
