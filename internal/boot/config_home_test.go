package boot

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"reasonix/internal/config"
	"reasonix/internal/history"
	"reasonix/internal/historycatalog"
)

// isolateConfigHome redirects user config and cache paths to a per-test temp
// directory. The history projection is process-global, so it must be closed on
// both sides of the environment change instead of retaining a deleted cache
// path across repeated tests.
func isolateConfigHome(t *testing.T) string {
	t.Helper()
	closeBootTestHistoryCatalog(t)
	dir := robustTempDir(t)
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("AppData", filepath.Join(dir, "AppData"))
	t.Setenv("LocalAppData", filepath.Join(dir, "LocalAppData"))
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	t.Setenv(config.CompletionValidationModeEnv, config.CompletionValidationOff)
	t.Cleanup(func() { closeBootTestHistoryCatalog(t) })
	return dir
}

// The process history catalog indexes asynchronously. On a loaded CI runner the
// initial open can take tens of seconds, so both the readiness wait and the
// close handshake need headroom well above a developer machine's timing: a
// close that still times out means the background open never observed its
// cancellation, which is a real defect rather than a slow runner.
const (
	bootTestCatalogReadyTimeout = 90 * time.Second
	bootTestCatalogCloseTimeout = 60 * time.Second
)

func closeBootTestHistoryCatalog(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), bootTestCatalogCloseTimeout)
	defer cancel()
	if err := history.CloseSharedCatalog(ctx); err != nil {
		t.Fatalf("close shared history catalog: %v", err)
	}
}

// fenceBootTestHistoryCatalog releases a process-global projection inherited
// from an earlier test and closes the replacement before t.TempDir cleanup.
// Windows cannot remove a temporary REASONIX_HOME while SQLite still owns it.
func fenceBootTestHistoryCatalog(t *testing.T) {
	t.Helper()
	closeBootTestHistoryCatalog(t)
	t.Cleanup(func() { closeBootTestHistoryCatalog(t) })
}

func bootTestHistoryIndexReady(t *testing.T) <-chan struct{} {
	t.Helper()
	ready := make(chan struct{})
	var once sync.Once
	history.RegisterCatalogObserver(func(status historycatalog.Status, _ []string, _ string) {
		if status.Indexed > 0 {
			once.Do(func() { close(ready) })
		}
	})
	return ready
}

func waitForBootTestHistoryIndex(t *testing.T, ready <-chan struct{}) {
	t.Helper()
	select {
	case <-ready:
	case <-time.After(bootTestCatalogReadyTimeout):
		t.Fatal("timed out waiting for history catalog to index the saved fixture")
	}
}
