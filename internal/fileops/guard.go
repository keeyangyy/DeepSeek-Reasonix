package fileops

import (
	"context"
	"errors"
	"fmt"
	"os"
)

// The two refusals a structured mutation can hit. They are sentinel errors so
// the tool layer can turn them into a stable diagnostic code without matching
// on message text.
var (
	// ErrNotObserved means the target was never handed to the model in this
	// session, so a write would be based on a guess.
	ErrNotObserved = errors.New("file has not been read in this session")
	// ErrStaleVersion means the file changed after it was read, so the write
	// would silently discard someone else's edit.
	ErrStaleVersion = errors.New("file changed after it was read")
)

// ObserveRead records the version of a file the host just delivered to the
// model. Callers pass the path the reader actually opened; a missing file is
// not recorded here because a read of it never produced a window.
func ObserveRead(ctx context.Context, path string) {
	store := FromContext(ctx)
	if store == nil {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	target, version := DiskSnapshot(path, info)
	if version == "" {
		return
	}
	store.ObservePresent(target, version)
}

// RequireObserved refuses a mutation whose target changed after this session
// read it, so a write never silently discards someone else's edit. A target
// that was never read is permitted: creating files and replacing them from a
// fresh description stays valid, and the host cannot distinguish "unread" from
// "intentionally written blind".
func RequireObserved(ctx context.Context, path string) error {
	store := FromContext(ctx)
	if store == nil {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		// Missing or unreadable targets carry no version to compare against.
		return nil
	}
	target, version := DiskSnapshot(path, info)
	observed := store.Get(target)
	if observed.Kind != Present || observed.Version == "" {
		return nil
	}
	if observed.Version != version {
		return fmt.Errorf("%w: %s changed since it was read; read it again before editing", ErrStaleVersion, path)
	}
	return nil
}

// CommitObserved records the version a mutation left behind, so consecutive
// edits do not each require another read.
func CommitObserved(ctx context.Context, path string) {
	store := FromContext(ctx)
	if store == nil {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		store.Forget(DiskTarget(path, nil))
		return
	}
	target, version := DiskSnapshot(path, info)
	if version == "" {
		return
	}
	store.ObservePresent(target, version)
}

// ObserveAbsent records that the host confirmed the target does not exist.
func ObserveAbsent(ctx context.Context, path string) {
	store := FromContext(ctx)
	if store == nil {
		return
	}
	store.ObserveAbsent(DiskTarget(path, nil))
}
