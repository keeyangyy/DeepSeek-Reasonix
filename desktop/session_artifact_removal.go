package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"reasonix/internal/agent"
	"reasonix/internal/control"
)

// removalMode picks recoverable trashing or in-place deletion.
type removalMode int

const (
	removalToTrash removalMode = iota
	removalPermanent
)

// PurgeSession permanently deletes a saved session and every artifact it owns
// instead of publishing a trash entry; the runtime is cancelled first, exactly
// as DeleteSession does before trashing.
func (a *App) PurgeSession(path string) error {
	return friendlySessionFileError(a.deleteSession(path, removalPermanent))
}

// cleanupPendingOperation keeps startup reconciliation on the same mode:
// "delete" finishes as a trash move, anything else deletes in place.
func cleanupPendingOperation(mode removalMode) string {
	if mode == removalPermanent {
		return "purge"
	}
	return "delete"
}

func removeSessionArtifactsByMode(mode removalMode, dir, sessionPath, key string) error {
	if mode == removalPermanent {
		return removeDesktopSessionArtifacts(sessionPath)
	}
	return trashSessionArtifacts(dir, sessionPath, key)
}

// removeSessionArtifactsWithGuardByMode is the guard-holding form, used while a
// topic removal already owns the session's removal guard.
func removeSessionArtifactsWithGuardByMode(mode removalMode, dir, sessionPath, key string, guard *agent.SessionRemovalGuard) error {
	if mode == removalPermanent {
		return removeDesktopSessionArtifactsWithGuard(sessionPath, guard)
	}
	return trashSessionArtifactsWithGuard(dir, sessionPath, key, guard)
}

func delayedSessionRetire(mode removalMode, dir, sessionPath, key string, destroys []control.SessionDestroyHandle) {
	if mode == removalPermanent {
		delayedDesktopSessionCleanup(sessionPath, destroys)
		return
	}
	delayedDesktopSessionTrash(dir, sessionPath, key, destroys)
}

func removeDesktopSessionArtifactsWithGuard(path string, guard *agent.SessionRemovalGuard) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if guard == nil {
		return fmt.Errorf("session removal guard is required")
	}
	defer guard.Release()
	if err := invalidateTopicDirMarkers(filepath.Dir(path)); err != nil {
		return err
	}
	defer invalidateTopicSessionIndexForPath(path)
	for _, artifact := range sessionOwnedArtifactPaths(path) {
		if strings.TrimSpace(artifact) == "" {
			continue
		}
		if err := os.RemoveAll(artifact); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := guard.RemoveSidecarsAndRelease(); err != nil {
		return err
	}
	if err := removeSessionDisplay(filepath.Dir(path), path); err != nil {
		return err
	}
	if err := removeSessionPlannerDisplay(filepath.Dir(path), path); err != nil {
		return err
	}
	if err := agent.DeleteSubagentsByParent(filepath.Dir(path), agent.BranchID(path)); err != nil {
		return err
	}
	return agent.ClearCleanupPending(path)
}
