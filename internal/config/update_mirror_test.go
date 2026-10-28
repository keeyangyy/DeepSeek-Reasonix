package config

import (
	"reflect"
	"testing"
)

func TestNormalizeMirrorPrefixAcceptsOnlyHTTPS(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://gh-proxy.com", "https://gh-proxy.com"},
		{"https://gh-proxy.com/", "https://gh-proxy.com"},
		{"  https://gh-proxy.com//  ", "https://gh-proxy.com"},
		// Plain http would let an on-path attacker rewrite catalog responses.
		{"http://gh-proxy.com", ""},
		{"gh-proxy.com", ""},
		{"ftp://gh-proxy.com", ""},
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := normalizeMirrorPrefix(tc.in); got != tc.want {
			t.Errorf("normalizeMirrorPrefix(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSetUpdateMirrorsDedupesAndDropsInvalid(t *testing.T) {
	cfg := &Config{}
	cfg.SetUpdateMirrors([]UpdateMirrorConfig{
		{URL: "https://a.example"},
		{URL: "https://a.example/"}, // duplicate after normalisation
		{URL: "http://b.example"},   // rejected: not https
		{URL: "https://c.example", Disabled: true},
	})

	got := cfg.Desktop.UpdateMirrors
	want := []UpdateMirrorConfig{
		{URL: "https://a.example"},
		{URL: "https://c.example", Disabled: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mirrors = %#v, want %#v", got, want)
	}
}

func TestUpdateMirrorPrefixesHonoursSwitchAndDisabledRows(t *testing.T) {
	cfg := &Config{}
	cfg.SetUpdateMirrors([]UpdateMirrorConfig{
		{URL: "https://a.example"},
		{URL: "https://b.example", Disabled: true},
		{URL: "https://c.example"},
	})

	got := cfg.UpdateMirrorPrefixes()
	want := []string{"https://a.example", "https://c.example"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("enabled prefixes = %v, want %v", got, want)
	}

	// The master switch wins over row state: off means no mirrors at all.
	cfg.SetUpdateSourceEnabled(false)
	if got := cfg.UpdateMirrorPrefixes(); got != nil {
		t.Fatalf("disabled source should yield no prefixes, got %v", got)
	}
}

func TestUpdateSourceMirrorsEnabledDefaultsOn(t *testing.T) {
	cfg := &Config{}
	if !cfg.UpdateSourceMirrorsEnabled() {
		t.Fatal("a fresh config should have mirrors enabled so existing files need no migration")
	}
	if (*Config)(nil).UpdateSourceMirrorsEnabled() != true {
		t.Fatal("nil config should read as enabled")
	}
	cfg.SetUpdateSourceEnabled(false)
	if cfg.UpdateSourceMirrorsEnabled() {
		t.Fatal("SetUpdateSourceEnabled(false) did not stick")
	}
}
