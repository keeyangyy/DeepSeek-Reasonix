package doctor

import (
	"os"
	"strings"
)

// isRedactionDerivedSidecar reports sidecars a transcript rewrite makes stale:
// the branch-metadata preview and the two context sidecars. They are processed
// before the transcript so the rewrite cannot leave one holding old content.
func isRedactionDerivedSidecar(name string) bool {
	return strings.HasSuffix(name, ".jsonl.meta") ||
		strings.HasSuffix(name, ".context.json") ||
		strings.HasSuffix(name, ".pinned-context.json")
}

// removeProjectionSidecar deletes a <id>.context.json sidecar. It is derived
// from the transcript, so dropping it loses nothing and stops the redacted
// history from being re-summarized out of a pre-redaction copy.
func removeProjectionSidecar(path string, dryRun bool) (int64, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	if info.IsDir() {
		return 0, 0, nil
	}
	if dryRun {
		return 1, 0, nil
	}
	if err := os.Remove(path); err != nil {
		return 0, 0, err
	}
	return 1, 0, nil
}
