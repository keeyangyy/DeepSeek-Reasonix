package update

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// answersCatalog records where the fetch went and replies without a network.
type answersCatalog struct {
	asked []string
	body  string
	fail  error
}

func (a *answersCatalog) RoundTrip(r *http.Request) (*http.Response, error) {
	a.asked = append(a.asked, r.URL.String())
	if a.fail != nil {
		return nil, a.fail
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(a.body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// Entries without a manifest are dropped by FetchIndex -- a rollback resolves
// through the target version's own manifest -- so a fixture without one lists
// nothing at all.
const twoReleases = `{"versions":[
  {"version":"2.11.0","tag":"studio-v2.11.0","manifest":"https://dl.reasonix.io/studio/2.11.0/manifest.json"},
  {"version":"2.9.0","tag":"studio-v2.9.0","manifest":"https://dl.reasonix.io/studio/2.9.0/manifest.json"}
]}`

func hubFor(t *testing.T, rt *answersCatalog, running string) VersionHub {
	t.Helper()
	return hubOver(context.Background(), Install{Version: running}, &http.Client{Transport: rt})
}

// Where the fetch lands is not a caller's to choose: Studio's catalog is a
// constant, and a build's own catalog is its own release point. Both are the
// build's decision; a third address is not.
func TestHubReadsOnlyTheCatalogsItDeclares(t *testing.T) {
	const mineCatalog = "https://example.test/mine-versions.json"
	rt := &answersCatalog{body: twoReleases}
	hubOver(context.Background(), Install{
		Version: "2.10.0",
		Mine:    &MineCatalog{Name: "mine", URL: mineCatalog},
	}, &http.Client{Transport: rt})
	if len(rt.asked) == 0 {
		t.Fatal("the hub read no catalog at all")
	}
	allowed := map[string]bool{StudioCatalog: true, mineCatalog: true}
	for _, url := range rt.asked {
		if !allowed[url] {
			t.Fatalf("fetched %q, want only the catalogs this build declares", url)
		}
	}
}

func TestHubPlacesTheRunningBuildAmongWhatIsPublished(t *testing.T) {
	hub := hubFor(t, &answersCatalog{body: twoReleases}, "2.10.0")
	if hub.Err != "" {
		t.Fatalf("hub carries an error for a catalog that answered: %q", hub.Err)
	}
	if hub.Latest != "2.11.0" || !hub.Newer {
		t.Fatalf("latest=%q newer=%v, want 2.11.0 and a newer release available", hub.Latest, hub.Newer)
	}
	// Three rows: the two published, plus the running build the catalog omits.
	if len(hub.Versions) != 3 {
		t.Fatalf("rows = %+v, want the running build merged in", hub.Versions)
	}
	if hub.Versions[0].Version != "2.11.0" || !hub.Versions[1].Current {
		t.Fatalf("rows = %+v, want newest first with the running build marked", hub.Versions)
	}
}

// An unreachable catalog must not hide which version is running: that row is
// the panel's only handle for pinning, so it cannot depend on the network.
func TestHubStillSaysWhatRunsWhenTheCatalogIsUnreachable(t *testing.T) {
	hub := hubFor(t, &answersCatalog{fail: errors.New("no route to host")}, "2.10.0")
	if hub.Err == "" {
		t.Fatal("a failed catalog read reported no error")
	}
	if hub.Current != "2.10.0" {
		t.Fatalf("current = %q, want the running build", hub.Current)
	}
	if len(hub.Versions) != 1 || !hub.Versions[0].Current {
		t.Fatalf("rows = %+v, want the running build alone and marked current", hub.Versions)
	}
}

// A nil slice marshals to null and a client that maps over it crashes its
// whole render, so an empty catalog stays an empty list.
func TestHubNeverAnswersWithANullList(t *testing.T) {
	hub := hubFor(t, &answersCatalog{body: `{"versions":[]}`}, "")
	if hub.Versions == nil {
		t.Fatal("versions is nil, which marshals to null")
	}
}
