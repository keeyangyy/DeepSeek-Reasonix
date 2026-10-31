package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"reasonix/internal/config"
)

// The signature is fetched by a different function than the artifact, so it used
// to bypass the mirror list entirely. On a network where GitHub is unreachable
// but a proxy works, that made every update fail at the last step even though the
// installer itself downloaded fine. The signature must try mirrors first, and
// only fall back to the official URL when every mirror has failed.
func TestSignatureFetchUsesMirrorsBeforeOfficial(t *testing.T) {
	fastRetry(t)
	t.Setenv("REASONIX_HOME", t.TempDir())

	cfg, err := config.LoadUserConfigReadOnly()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.SetUpdateMirrors([]config.UpdateMirrorConfig{{URL: "https://mirror.example"}})
	if !cfg.UpdateSourceMirrorsEnabled() {
		t.Fatal("SetUpdateMirrors must leave mirror acceleration on")
	}
	if err := cfg.SaveTo(config.UserConfigPath()); err != nil {
		t.Fatalf("save config: %v", err)
	}

	official := "https://example.invalid/Reasonix-windows-amd64-installer.exe.minisig"
	var seen []string
	client := &http.Client{Transport: rtFunc(func(req *http.Request) (*http.Response, error) {
		seen = append(seen, req.URL.String())
		if strings.HasPrefix(req.URL.String(), "https://mirror.example/") {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				ContentLength: 4,
				Body:          io.NopCloser(strings.NewReader("sig!")),
				Header:        make(http.Header),
			}, nil
		}
		return nil, errors.New("official route unreachable")
	})}

	data, err := fetchBytesFallbackForChannelSized(context.Background(), client, nil, "stable", official, 64)
	if err != nil {
		t.Fatalf("signature fetch failed: %v (attempts: %v)", err, seen)
	}
	if string(data) != "sig!" {
		t.Fatalf("signature body = %q, want %q", data, "sig!")
	}
	if len(seen) == 0 || !strings.HasPrefix(seen[0], "https://mirror.example/") {
		t.Fatalf("first attempt = %v, want the mirror prefix", seen)
	}
	for _, attempt := range seen {
		if attempt == official {
			t.Fatalf("official URL was tried although a mirror worked: %v", seen)
		}
	}
}

// With no mirrors configured the official URL stays the only candidate: the
// expansion must be a no-op rather than a rewrite of the address.
func TestSignatureFetchWithoutMirrorsUsesOfficial(t *testing.T) {
	fastRetry(t)
	t.Setenv("REASONIX_HOME", t.TempDir())

	official := "https://example.invalid/Reasonix-windows-amd64-installer.exe.minisig"
	var seen []string
	client := &http.Client{Transport: rtFunc(func(req *http.Request) (*http.Response, error) {
		seen = append(seen, req.URL.String())
		return &http.Response{
			StatusCode:    http.StatusOK,
			Status:        "200 OK",
			ContentLength: 4,
			Body:          io.NopCloser(strings.NewReader("sig!")),
			Header:        make(http.Header),
		}, nil
	})}

	if _, err := fetchBytesFallbackForChannelSized(context.Background(), client, nil, "stable", official, 64); err != nil {
		t.Fatalf("signature fetch failed: %v", err)
	}
	if len(seen) != 1 || seen[0] != official {
		t.Fatalf("attempts = %v, want exactly the official URL", seen)
	}
}
