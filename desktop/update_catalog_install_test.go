package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"reasonix/desktop/internal/update"
)

// A catalog entry's manifest URL must stay under this line's release download
// base: the manifest itself is signature-verified, but an arbitrary address
// would let a hostile catalog redirect the fetch itself.
func TestValidateCatalogManifestURL(t *testing.T) {
	good := releaseDownloadBase + "v1.38.54-beta.2/latest.json"
	if err := validateCatalogManifestURL(good); err != nil {
		t.Errorf("validateCatalogManifestURL(%q) = %v, want nil", good, err)
	}
	for _, bad := range []string{
		"https://evil.example/v1.38.54/latest.json",
		"https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/v1.38.54/other.json",
		"http://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/v1.38.54/latest.json",
		"https://github.com/attacker/DeepSeek-Reasonix/releases/download/v1.38.54/latest.json",
		"",
	} {
		if err := validateCatalogManifestURL(bad); err == nil {
			t.Errorf("validateCatalogManifestURL(%q) accepted a URL outside the release base", bad)
		}
	}
}

// Picking a version from the list may name a pre-release; the automatic update
// path must keep rejecting one.
func TestValidateVersionedUpdaterRequestAllowsPrerelease(t *testing.T) {
	_, _, version, err := validateVersionedUpdaterRequest("web-1", "stable", "v1.38.54-beta.2")
	if err != nil {
		t.Fatalf("validateVersionedUpdaterRequest rejected a pre-release: %v", err)
	}
	if version != "v1.38.54-beta.2" {
		t.Errorf("version = %q, want v1.38.54-beta.2", version)
	}
	if _, _, _, err := validateUpdaterRequest("web-1", "stable", "v1.38.54-beta.2"); err == nil {
		t.Error("validateUpdaterRequest accepted a pre-release for the automatic path")
	}
	for _, bad := range []string{"latest", "v1.38.54-rc.1", "1.38.54", ""} {
		if _, _, _, err := validateVersionedUpdaterRequest("web-1", "stable", bad); err == nil {
			t.Errorf("validateVersionedUpdaterRequest accepted %q", bad)
		}
	}
}

func jsonResponse(t *testing.T, payload any) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Body:       io.NopCloser(bytes.NewReader(body)),
		Header:     make(http.Header),
	}
}

func manifestResponse(t *testing.T, version string) *http.Response {
	t.Helper()
	return jsonResponse(t, validDesktopManifest(t, "stable", version))
}

const betaManifestURL = releaseDownloadBase + "v1.38.55-beta.1/latest.json"

// catalogRoutes serves the anchor manifest, the catalog, and one entry's own
// manifest, counting which sources were touched.
type catalogRoutes struct {
	anchorVersion string
	entries       []update.CatalogEntry
	anchorHits    int
	catalogHits   int
	entryHits     int
}

func (r *catalogRoutes) client(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{Transport: rtFunc(func(req *http.Request) (*http.Response, error) {
		switch path := req.URL.Path; {
		case strings.HasSuffix(path, "/wails-latest/latest.json"):
			r.anchorHits++
			return manifestResponse(t, r.anchorVersion), nil
		case strings.HasSuffix(path, "/wails-latest/versions.json"):
			r.catalogHits++
			return jsonResponse(t, update.Catalog{SchemaVersion: 1, Versions: r.entries}), nil
		case strings.HasSuffix(path, "/v1.38.55-beta.1/latest.json"):
			r.entryHits++
			return manifestResponse(t, "v1.38.55-beta.1"), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", req.URL)
		}
	})}
}

func (r *catalogRoutes) resolve(t *testing.T, wantVersion string) (*update.Manifest, bool, error) {
	t.Helper()
	return resolveUpdateManifestWith(context.Background(), r.client(t), nil, "stable", wantVersion,
		[]string{githubManifestFallback}, []string{githubCatalogFallback})
}

// The anchor is enough for the release it currently describes, so the list is
// not read on the ordinary update path.
func TestResolveUpdateManifestUsesAnchorForCurrentRelease(t *testing.T) {
	r := &catalogRoutes{anchorVersion: "v1.38.54"}
	m, explicit, err := r.resolve(t, "v1.38.54")
	if err != nil {
		t.Fatalf("resolveUpdateManifestWith: %v", err)
	}
	if explicit {
		t.Error("the anchor's own release was reported as an explicit catalog install")
	}
	if m.Version != "v1.38.54" {
		t.Errorf("manifest version = %q, want v1.38.54", m.Version)
	}
	if r.catalogHits != 0 {
		t.Errorf("catalog was read %d times for the current release, want 0", r.catalogHits)
	}
}

// A version the anchor does not describe comes from its own catalog entry —
// including a pre-release, which the anchor path would reject.
func TestResolveUpdateManifestReadsCatalogForPickedVersion(t *testing.T) {
	r := &catalogRoutes{
		anchorVersion: "v1.38.54",
		entries: []update.CatalogEntry{
			{Version: "v1.38.55-beta.1", Tag: "v1.38.55-beta.1", Channel: update.ChannelBeta, Manifest: betaManifestURL},
			{Version: "v1.38.54", Tag: "v1.38.54", Channel: update.ChannelStable, Manifest: releaseDownloadBase + "v1.38.54/latest.json"},
		},
	}
	m, explicit, err := r.resolve(t, "v1.38.55-beta.1")
	if err != nil {
		t.Fatalf("resolveUpdateManifestWith: %v", err)
	}
	if !explicit {
		t.Error("a catalog install was not reported as explicit")
	}
	if m.Version != "v1.38.55-beta.1" {
		t.Errorf("manifest version = %q, want v1.38.55-beta.1", m.Version)
	}
	if r.catalogHits != 1 || r.entryHits != 1 {
		t.Errorf("catalog hits = %d, entry hits = %d, want 1 and 1", r.catalogHits, r.entryHits)
	}
}

func TestResolveUpdateManifestRejectsUnknownVersion(t *testing.T) {
	r := &catalogRoutes{
		anchorVersion: "v1.38.54",
		entries: []update.CatalogEntry{
			{Version: "v1.38.54", Tag: "v1.38.54", Channel: update.ChannelStable, Manifest: releaseDownloadBase + "v1.38.54/latest.json"},
		},
	}
	if _, _, err := r.resolve(t, "v9.9.9"); err == nil {
		t.Fatal("resolveUpdateManifestWith accepted a version the catalog does not list")
	}
}

// A catalog entry pointing somewhere else must fail before any fetch happens.
func TestResolveUpdateManifestRejectsForeignManifestURL(t *testing.T) {
	r := &catalogRoutes{
		anchorVersion: "v1.38.54",
		entries: []update.CatalogEntry{
			{Version: "v1.38.55-beta.1", Tag: "v1.38.55-beta.1", Channel: update.ChannelBeta, Manifest: "https://evil.example/v1.38.55-beta.1/latest.json"},
		},
	}
	if _, _, err := r.resolve(t, "v1.38.55-beta.1"); err == nil {
		t.Fatal("resolveUpdateManifestWith followed a manifest URL outside the release base")
	}
	if r.entryHits != 0 {
		t.Errorf("entry hits = %d, want 0: the URL must be rejected before fetching", r.entryHits)
	}
}
