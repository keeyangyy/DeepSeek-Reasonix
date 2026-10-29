package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"

	"reasonix/internal/config"
)

// Update mirrors are pure request-path rewrites: the official URL stays the
// canonical identity everywhere it matters (catalog entries, manifest asset
// URLs, signature URLs), and only the address we dial gets the proxy prefix.
//
// That keeps two existing guarantees untouched:
//   - the manifest/asset allow-lists still validate official paths verbatim;
//   - installer authenticity still rests on the embedded minisign key, so a
//     hostile proxy can withhold or corrupt bytes but cannot forge a release.
func readMirrorPrefixes() []string {
	cfg, err := config.LoadUserConfigReadOnly()
	if err != nil || cfg == nil {
		return builtinUpdateMirrors
	}
	if !cfg.UpdateSourceMirrorsEnabled() {
		return nil
	}
	// A config that never saved a list still means "use the defaults": the
	// settings panel shows the built-in mirrors for exactly that state.
	if len(cfg.Desktop.UpdateMirrors) == 0 {
		return builtinUpdateMirrors
	}
	return cfg.UpdateMirrorPrefixes()
}

// withMirrors expands official URLs into "each mirror first, official last",
// preserving the official ordering inside each mirror pass. With no mirrors it
// returns the input untouched so the disabled path costs nothing.
func withMirrors(official []string) []string {
	return expandWithMirrors(readMirrorPrefixes(), official)
}

// expandWithMirrors is the pure half: mirrors are tried per official URL and the
// official list always comes last, so a mirror can never hide the real source.
func expandWithMirrors(prefixes, official []string) []string {
	if len(prefixes) == 0 {
		return official
	}
	out := make([]string, 0, len(prefixes)*len(official)+len(official))
	for _, url := range official {
		for _, prefix := range prefixes {
			out = append(out, proxiedURL(prefix, url))
		}
	}
	return append(out, official...)
}

// proxiedURL joins a proxy prefix and an absolute target URL. Mirrors follow the
// widely used "<proxy>/<full-url>" shape.
func proxiedURL(prefix, target string) string {
	return strings.TrimRight(prefix, "/") + "/" + target
}

// downloadOnce performs a single URL attempt with the transient retry policy.
// It lives beside the mirror code so updater.go keeps its size budget.
func downloadOnce(ctx context.Context, c, fallback *http.Client, selected, url string, total int64, onProgress func(received, total int64)) ([]byte, error) {
	expectedSize := total
	var buf bytes.Buffer
	err := retryTransient(ctx, func(attempt int) error {
		client := c
		if attempt > 1 && fallback != nil {
			client = fallback
		}
		return downloadInto(ctx, client, selected, url, expectedSize, &buf, &total, onProgress)
	})
	if err != nil {
		return nil, err
	}
	if expectedSize > 0 && int64(buf.Len()) != expectedSize {
		return nil, fmt.Errorf("update: downloaded size mismatch: got %d want %d", buf.Len(), expectedSize)
	}
	return buf.Bytes(), nil
}
