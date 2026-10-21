package historycatalog

import "context"

// statusContextOrBackground keeps status refreshes bound to the catalog's worker
// context, so a shutdown cancels them instead of letting them run on. A catalog
// built without Open (tests, zero value) has no worker context, and there the
// refresh still needs a live context.
func statusContextOrBackground(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
