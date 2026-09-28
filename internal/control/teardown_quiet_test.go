package control

import (
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
		_ = filepath.Walk(dir, func(p string, _ os.FileInfo, err error) error {
			if err == nil {
				sb.WriteString(p)
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
