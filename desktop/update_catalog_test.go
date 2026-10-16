package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"reasonix/desktop/internal/update"
)

// The release workflow decides an entry's channel from the tag's shape, so the
// client-side fallback must agree with it for a catalog entry that omits the
// field.
func TestChannelOfVersion(t *testing.T) {
	cases := map[string]string{
		"v1.38.54":          update.ChannelStable,
		"v1.38.54-beta.2":   update.ChannelBeta,
		"v1.38.100-beta.11": update.ChannelBeta,
		"1.38.54":           update.ChannelStable, // normalizeVersion adds the "v" later
		"v1.38.54-rc.1":     update.ChannelStable, // only the beta suffix marks a pre-release here
	}
	for version, want := range cases {
		if got := channelOfVersion(version); got != want {
			t.Errorf("channelOfVersion(%q) = %q, want %q", version, got, want)
		}
	}
}

const catalogBody = `{"schemaVersion":1,"updatedAt":"2026-10-16T00:00:00Z","versions":[
	{"version":"v1.38.55-beta.1","tag":"v1.38.55-beta.1","channel":"beta","publishedAt":"2026-10-16T10:00:00Z","manifest":"https://example.test/v1.38.55-beta.1/latest.json"},
	{"version":"v1.38.54","tag":"v1.38.54","channel":"stable","publishedAt":"2026-10-15T10:00:00Z","manifest":"https://example.test/v1.38.54/latest.json"}
]}`

func catalogServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(catalogBody))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchCatalogFromReadsEntries(t *testing.T) {
	srv := catalogServer(t)
	cat, err := fetchCatalogFrom(context.Background(), srv.Client(), nil, "stable", []string{srv.URL})
	if err != nil {
		t.Fatalf("fetchCatalogFrom: %v", err)
	}
	if len(cat.Versions) != 2 {
		t.Fatalf("got %d entries, want 2", len(cat.Versions))
	}
	first := cat.Versions[0]
	if first.Version != "v1.38.55-beta.1" || first.Channel != update.ChannelBeta {
		t.Errorf("first entry = %+v, want the beta release", first)
	}
	if first.Manifest != "https://example.test/v1.38.55-beta.1/latest.json" {
		t.Errorf("first entry manifest = %q", first.Manifest)
	}
	if cat.Versions[1].Channel != update.ChannelStable || cat.Versions[1].PublishedAt == "" {
		t.Errorf("second entry = %+v, want the stable release with its timestamp", cat.Versions[1])
	}
}

// A corrupt or empty catalog must fail rather than render an empty list: losing
// the version history is exactly what the catalog exists to prevent.
func TestFetchCatalogFromRejectsBadCatalogs(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"empty versions", `{"schemaVersion":1,"versions":[]}`},
		{"no versions field", `{"schemaVersion":1}`},
		{"not json", `not json at all`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			if _, err := fetchCatalogFrom(context.Background(), srv.Client(), nil, "stable", []string{srv.URL}); err == nil {
				t.Fatalf("fetchCatalogFrom accepted %s", tc.name)
			}
		})
	}
}

// Endpoints are tried in order: a dead first source must not hide a good one.
func TestFetchCatalogFromUsesLaterEndpoint(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer dead.Close()
	good := catalogServer(t)
	cat, err := fetchCatalogFrom(context.Background(), good.Client(), nil, "stable", []string{dead.URL, good.URL})
	if err != nil {
		t.Fatalf("fetchCatalogFrom: %v", err)
	}
	if len(cat.Versions) != 2 {
		t.Fatalf("got %d entries, want 2", len(cat.Versions))
	}
}
