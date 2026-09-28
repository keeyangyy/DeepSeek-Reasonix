package control

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// closeControllerQuiet closes c and waits until its session directory stops
// changing and the autosave goroutine has exited, so t.TempDir() cleanup
// cannot race a controller background write on slow -race CI machines.
func closeControllerQuiet(t *testing.T, c *Controller, dir string) {
	t.Helper()
	c.Close()
	c.autosaveWG.Wait()
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
