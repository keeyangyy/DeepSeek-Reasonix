package agent

import (
	"fmt"
	"strings"
)

// LoadSessionEffort reads the reasoning effort override saved beside a session
// transcript. An empty value means the session runs at "auto" (the provider
// default); the boolean reports whether a sidecar was available at all.
func LoadSessionEffort(sessionPath string) (string, bool) {
	meta, ok, err := LoadBranchMeta(sessionPath)
	if err != nil || !ok {
		return "", false
	}
	return strings.TrimSpace(meta.Effort), true
}

// SetBranchEffortPreserveUpdated stores the reasoning effort override without
// changing the session activity timestamp. An empty effort records "auto",
// which is also what a conversation without a record falls back to.
func SetBranchEffortPreserveUpdated(sessionPath, effort string) error {
	if sessionPath == "" {
		return fmt.Errorf("empty session path")
	}
	unlock, err := LockSessionMetaPath(sessionPath)
	if err != nil {
		return err
	}
	defer unlock()
	meta, err := ensureBranchMetaUnlocked(sessionPath)
	if err != nil {
		return err
	}
	meta.Effort = strings.TrimSpace(effort)
	return saveBranchMeta(sessionPath, meta, false)
}
