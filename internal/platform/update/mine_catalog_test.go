package update

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aead.dev/minisign"

	"reasonix/internal/base/tempdir"
)

// routeCatalog answers each declared catalog with its own body, so a test can
// give Studio's catalog and a build's own catalog different releases.
type routeCatalog struct {
	byURL map[string]string
	asked []string
}

func (r *routeCatalog) RoundTrip(req *http.Request) (*http.Response, error) {
	url := req.URL.String()
	r.asked = append(r.asked, url)
	body, ok := r.byURL[url]
	if !ok {
		return nil, fmt.Errorf("no catalog at %s", url)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

const studioTwoReleases = `{"versions":[
  {"version":"2.30.0","tag":"studio-v2.30.0","manifest":"https://dl.reasonix.io/studio/2.30.0/latest.json"},
  {"version":"2.29.0","tag":"studio-v2.29.0","manifest":"https://dl.reasonix.io/studio/2.29.0/latest.json"}
]}`

// Four of the fork's releases, so a budget of three has one to drop.
const forkFourReleases = `{"versions":[
  {"version":"2.30.0-mine.2","tag":"v2.30.0-mine.2","manifest":"https://example.test/mine/2.30.0-mine.2/latest.json"},
  {"version":"2.30.0-mine.1","tag":"v2.30.0-mine.1","manifest":"https://example.test/mine/2.30.0-mine.1/latest.json"},
  {"version":"2.29.0-mine.1","tag":"v2.29.0-mine.1","manifest":"https://example.test/mine/2.29.0-mine.1/latest.json"},
  {"version":"2.28.0-mine.2","tag":"v2.28.0-mine.2","manifest":"https://example.test/mine/2.28.0-mine.2/latest.json"}
]}`

const forkCatalogURL = "https://example.test/mine/versions.json"

func forkInstall(running string, max int) Install {
	return Install{Version: running, Mine: &MineCatalog{
		Name: "mine", URL: forkCatalogURL, PublicKey: forkPublicKey, MaxEntries: max,
	}}
}

// The fork's own releases sit beside Studio's, and the budget keeps the list
// short: newest first, with the running build's row always present.
func TestHubListsTheForksOwnReleasesWithinTheirBudget(t *testing.T) {
	rt := &routeCatalog{byURL: map[string]string{StudioCatalog: studioTwoReleases, forkCatalogURL: forkFourReleases}}
	hub := hubOver(context.Background(), forkInstall("2.30.0-mine.1", 3), &http.Client{Transport: rt})
	if hub.Err != "" {
		t.Fatalf("both catalogs answered, so the hub must carry no error: %q", hub.Err)
	}
	// The newest 3 of the fork's 4, Studio's 2, and no separate row for the
	// running build because the fork's own catalog already lists it.
	want := []string{"2.30.0", "2.30.0-mine.2", "2.30.0-mine.1", "2.29.0", "2.29.0-mine.1"}
	if got := rowVersions(hub.Versions); !sameStrings(got, want) {
		t.Fatalf("rows = %v, want %v", got, want)
	}
	wantSource := map[string]string{
		"2.30.0": "", "2.29.0": "",
		"2.30.0-mine.2": "mine", "2.30.0-mine.1": "mine", "2.29.0-mine.1": "mine",
	}
	current := 0
	for _, row := range hub.Versions {
		if row.Source != wantSource[row.Version] {
			t.Errorf("row %s carries source %q, want %q", row.Version, row.Source, wantSource[row.Version])
		}
		if row.Current {
			current++
			if row.Version != "2.30.0-mine.1" {
				t.Errorf("row %s is marked current, want only the running build", row.Version)
			}
		}
	}
	if current != 1 {
		t.Fatalf("marked %d rows current, want exactly the running build", current)
	}
	if hub.Latest != "2.30.0" || !hub.Newer {
		t.Fatalf("latest=%q newer=%v, want Studio's 2.30.0 ahead of the fork's build", hub.Latest, hub.Newer)
	}
	if hub.Versions[1].Older {
		t.Error("the fork's newest release is ahead of the running build, not behind it")
	}
}

// An unreachable second catalog costs its own rows and nothing else: what runs
// and what Studio published still have to be on screen.
func TestHubKeepsTheRunningBuildWhenTheForksCatalogFails(t *testing.T) {
	rt := &routeCatalog{byURL: map[string]string{StudioCatalog: studioTwoReleases}}
	hub := hubOver(context.Background(), forkInstall("2.30.0-mine.1", 3), &http.Client{Transport: rt})
	// Newest first, so the running build sits between Studio's two: it is newer
	// than 2.29.0 and older than 2.30.0.
	if got := rowVersions(hub.Versions); !sameStrings(got, []string{"2.30.0", "2.30.0-mine.1", "2.29.0"}) {
		t.Fatalf("rows = %v, want Studio's two plus the running build", got)
	}
	if !strings.Contains(hub.Err, "mine") {
		t.Fatalf("err = %q, want the catalog that failed named", hub.Err)
	}
}

// A key is chosen by the catalog an artifact came from: the declared one when
// there is one, Studio's own when there is not — never "any signature".
func TestVerifyWithSourceNeverSkipsVerification(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	text, err := pub.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("the fork's build")
	sig := minisign.Sign(priv, data)
	if err := VerifyWithSource(string(text), data, sig); err != nil {
		t.Fatalf("the declared key must verify its own artifact: %v", err)
	}
	if err := VerifyWithSource("", data, sig); err == nil {
		t.Fatal("an empty key is Studio's, so a throwaway key's signature must not verify")
	}
	if err := VerifyWithSource(forkPublicKey, data, sig); err == nil {
		t.Fatal("the fork's key must not verify another key's signature")
	}
	if err := Verify(data, sig); err == nil {
		t.Fatal("Verify still checks against the embedded Studio key")
	}
}

// serveSignedRelease serves one version's catalog, manifest and signed artifact
// under a throwaway key, and leaves the package's verify hook alone so the key
// the Options carry is the one that decides.
func serveSignedRelease(t *testing.T, version string, artifact []byte) (*releaseServer, string) {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	text, err := pub.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	rs := &releaseServer{}
	mux := http.NewServeMux()
	rs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.hits.Add(1)
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(rs.Close)
	name := "Reasonix-" + CurrentPlatform() + ".tar.gz"
	base := rs.URL + "/" + version + "/"
	idx := Index{SchemaVersion: 1, Versions: []IndexEntry{
		{Version: version, Tag: version, Manifest: base + "latest.json"},
	}}
	m := Manifest{Version: version, Platforms: map[string]Asset{CurrentPlatform(): {
		URL: base + name, Sig: base + name + ".minisig",
		Size: int64(len(artifact)), SHA256: sha256Hex(artifact),
	}}}
	mux.HandleFunc("/"+version+"/latest.json", serveJSON(t, m))
	mux.HandleFunc("/"+version+"/"+name, serveBytes(artifact))
	mux.HandleFunc("/"+version+"/"+name+".minisig", serveBytes(minisign.Sign(priv, artifact)))
	mux.HandleFunc("/versions.json", serveJSON(t, idx))
	return rs, string(text)
}

// Download verifies under the key the catalog declared, which is what lets a
// second catalog's artifacts install at all.
func TestDownloadVerifiesUnderTheCatalogsKey(t *testing.T) {
	rs, pubText := serveSignedRelease(t, "v2.0.0", []byte("the fork's build"))
	withKey := New(Options{
		Current: "v1.0.0", IndexURL: rs.URL + "/versions.json", HTTP: rs.Client(),
		CacheDir: tempdir.New(t), PublicKey: pubText,
	})
	if _, err := withKey.Download(context.Background(), "v2.0.0", Report{}); err != nil {
		t.Fatalf("the declared key must download its own artifact: %v", err)
	}
	withoutKey := New(Options{
		Current: "v1.0.0", IndexURL: rs.URL + "/versions.json", HTTP: rs.Client(),
		CacheDir: tempdir.New(t),
	})
	if _, err := withoutKey.Download(context.Background(), "v2.0.0", Report{}); err == nil {
		t.Fatal("a catalog that declares no key is Studio's own, so this artifact must not download")
	}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
