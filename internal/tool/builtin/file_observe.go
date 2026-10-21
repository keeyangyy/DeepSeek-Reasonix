package builtin

import (
	"context"

	"reasonix/internal/fileops"
)

// observeReadOnSuccess records the version a read window came from. It lives
// here rather than inline so readFile.Execute stays inside the function-size
// budget; the caller defers it so every successful return path is covered.
func observeReadOnSuccess(ctx context.Context, path string, out string, err error) {
	if err == nil && out != "" && path != "" {
		fileops.ObserveRead(ctx, path)
	}
}

// commitObservedOnSuccess records the version a mutation left behind, so the
// next edit on the same file does not need another read.
func commitObservedOnSuccess(ctx context.Context, path string, err error) {
	if err == nil && path != "" {
		fileops.CommitObserved(ctx, path)
	}
}

// requireObservedTarget refuses a mutation whose target version this session
// never read, or whose version changed since it was read.
func requireObservedTarget(ctx context.Context, path string) error {
	return fileops.RequireObserved(ctx, path)
}
