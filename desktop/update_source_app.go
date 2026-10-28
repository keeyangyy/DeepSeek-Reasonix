package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"reasonix/internal/config"
)

// Builtin mirrors verified against the real latest.json on 2026-10-28. They live
// here rather than in the frontend so a dead mirror can be replaced by shipping
// a build, and "restore defaults" always means the current line's list.
var builtinUpdateMirrors = []string{
	"https://gh-proxy.com",
	"https://ghfast.top",
	"https://githubproxy.cc",
	"https://ghproxy.imciel.com",
}

// UpdateSourceMirrorView is one row of the mirror list in Settings > Updates.
type UpdateSourceMirrorView struct {
	URL      string `json:"url"`
	Disabled bool   `json:"disabled"`
}

// UpdateSourceView is the whole update-source configuration.
type UpdateSourceView struct {
	Enabled bool                     `json:"enabled"`
	Mirrors []UpdateSourceMirrorView `json:"mirrors"`
}

// MirrorProbeView is one mirror's latency probe result.
type MirrorProbeView struct {
	URL       string `json:"url"`
	LatencyMs int64  `json:"latencyMs"`
	Error     string `json:"error,omitempty"`
}

// GetUpdateSource returns the current mirror configuration, filling in the
// built-in list when the user has never customised it.
func (a *App) GetUpdateSource() UpdateSourceView {
	enabled := true
	rows := make([]UpdateSourceMirrorView, 0, len(builtinUpdateMirrors))
	if cfg, err := config.LoadUserConfigReadOnly(); err == nil && cfg != nil {
		enabled = cfg.UpdateSourceMirrorsEnabled()
		for _, m := range cfg.Desktop.UpdateMirrors {
			rows = append(rows, UpdateSourceMirrorView{URL: m.URL, Disabled: m.Disabled})
		}
	}
	if len(rows) == 0 {
		for _, url := range builtinUpdateMirrors {
			rows = append(rows, UpdateSourceMirrorView{URL: url})
		}
	}
	return UpdateSourceView{Enabled: enabled, Mirrors: rows}
}

// SetUpdateSource persists the mirror list. Validation lives in config so the
// same https-and-dedupe rules apply to every writer.
func (a *App) SetUpdateSource(view UpdateSourceView) error {
	mirrors := make([]config.UpdateMirrorConfig, 0, len(view.Mirrors))
	for _, m := range view.Mirrors {
		mirrors = append(mirrors, config.UpdateMirrorConfig{URL: m.URL, Disabled: m.Disabled})
	}
	return a.applyConfigOnly(func(c *config.Config) error {
		c.SetUpdateSourceEnabled(view.Enabled)
		c.SetUpdateMirrors(mirrors)
		return nil
	})
}

// probeOne mirrors the catalog request through one prefix and reports latency.
func probeOne(ctx context.Context, prefix string) MirrorProbeView {
	out := MirrorProbeView{URL: prefix}
	target := proxiedURL(prefix, githubCatalogFallback)
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	req.Header.Set("User-Agent", updaterUserAgent(""))
	client, clientErr := httpClientIPv4()
	if clientErr != nil || client == nil {
		client = http.DefaultClient
	}
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		out.Error = trimmedError(err)
		return out
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		out.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return out
	}
	out.LatencyMs = time.Since(started).Milliseconds()
	return out
}

// TestUpdateMirrors probes every mirror concurrently and returns the results in
// the input order. Probing never reorders anything by itself: the panel offers
// sorting as a separate action so a test cannot silently move the user's list.
func (a *App) TestUpdateMirrors(urls []string) []MirrorProbeView {
	ctx := a.reqCtx()
	results := make([]MirrorProbeView, len(urls))
	var wg sync.WaitGroup
	for i, raw := range urls {
		wg.Add(1)
		go func(i int, raw string) {
			defer wg.Done()
			prefix := strings.TrimRight(strings.TrimSpace(raw), "/")
			if prefix == "" {
				results[i] = MirrorProbeView{URL: raw, Error: "empty mirror"}
				return
			}
			results[i] = probeOne(ctx, prefix)
		}(i, raw)
	}
	wg.Wait()
	return results
}

func trimmedError(err error) string {
	msg := err.Error()
	if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
		msg = msg[:idx]
	}
	return strings.TrimSpace(msg)
}
