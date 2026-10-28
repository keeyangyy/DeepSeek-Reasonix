package main

import (
	"reflect"
	"testing"
)

func TestExpandWithMirrorsKeepsOfficialLast(t *testing.T) {
	official := []string{"https://github.com/o/r/releases/download/wails-latest/latest.json"}
	prefixes := []string{"https://a.example", "https://b.example"}

	got := expandWithMirrors(prefixes, official)
	want := []string{
		"https://a.example/https://github.com/o/r/releases/download/wails-latest/latest.json",
		"https://b.example/https://github.com/o/r/releases/download/wails-latest/latest.json",
		"https://github.com/o/r/releases/download/wails-latest/latest.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expandWithMirrors mismatch\n got %v\nwant %v", got, want)
	}
}

func TestExpandWithMirrorsWithoutMirrorsIsIdentity(t *testing.T) {
	official := []string{"https://github.com/x", "https://github.com/y"}
	got := expandWithMirrors(nil, official)
	if !reflect.DeepEqual(got, official) {
		t.Fatalf("no mirrors should return the input untouched, got %v", got)
	}
}

// Every official URL must still be reachable after expansion: a mirror list can
// reorder attempts but can never remove the real source.
func TestExpandWithMirrorsAlwaysIncludesOfficial(t *testing.T) {
	official := []string{"https://github.com/a", "https://github.com/b"}
	got := expandWithMirrors([]string{"https://m1.example", "https://m2.example"}, official)

	seen := make(map[string]bool, len(got))
	for _, u := range got {
		seen[u] = true
	}
	for _, want := range official {
		if !seen[want] {
			t.Fatalf("official URL %q missing from expanded list %v", want, got)
		}
	}
	if len(got) != 2*len(official)+len(official) {
		t.Fatalf("unexpected expansion size %d for %v", len(got), got)
	}
}

func TestProxiedURLJoinsWithoutDoubleSlash(t *testing.T) {
	got := proxiedURL("https://gh-proxy.com/", "https://github.com/a/b")
	want := "https://gh-proxy.com/https://github.com/a/b"
	if got != want {
		t.Fatalf("proxiedURL = %q, want %q", got, want)
	}
}
