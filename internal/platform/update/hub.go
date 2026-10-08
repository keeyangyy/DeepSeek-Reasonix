package update

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"reasonix/internal/base/netclient"
	"reasonix/internal/contract/config"
)

// StudioCatalog is Studio's own rollback catalog, published by
// release-studio.yml. It stays a constant rather than something a caller
// names: a catalog that could be pointed elsewhere is one whose entries would
// offer to "update" Studio into a different product. A build that publishes its
// own releases declares a second catalog in Install.Mine, beside this one.
const StudioCatalog = StudioMirror + "/studio/versions.json"

// MineCatalog is a second catalog a build declares beside Studio's: the same
// shape, its own signing key, its own row budget. It exists so a build that
// ships its own releases is listed where the running build is, while neither
// catalog can answer for the other's artifacts.
type MineCatalog struct {
	// Name marks the rows this catalog contributes.
	Name string
	// URL is that catalog's versions.json.
	URL string
	// PublicKey is the minisign key this catalog's artifacts are signed with.
	// Empty means Studio's own key, never "any signature will do".
	PublicKey string
	// MaxEntries caps how many of this catalog's versions are listed (0 = no
	// cap). The running build's own row is added regardless of the cap.
	MaxEntries int
}

// Install is what a shell knows about itself that the kernel cannot work out.
// A Go process inside an Electron bundle resolves neither half: os.Executable()
// names the host binary, and the version is stamped into the application that
// spawned it. A shell that cannot answer leaves both empty and gets a hub that
// says what runs without offering to change it.
type Install struct {
	Version string
	Layout  Layout
	// Mine is the build's own catalog, listed beside Studio's. nil keeps the
	// panel upstream-only.
	Mine *MineCatalog
}

// VersionEntry is one published release as a version panel shows it.
type VersionEntry struct {
	Version     string `json:"version"`
	Tag         string `json:"tag"`
	PublishedAt string `json:"publishedAt"`
	HasNotes    bool   `json:"hasNotes"`
	Current     bool   `json:"current"`
	Older       bool   `json:"older"`
	// Source names the catalog that published this row; "" is Studio's own.
	Source string `json:"source,omitempty"`
}

// VersionHub is everything a version panel renders from. Err is carried beside
// the data rather than replacing it: an unreachable catalog must not hide which
// version is running.
type VersionHub struct {
	Current  string         `json:"current"`
	Pinned   string         `json:"pinned"`
	StalePin bool           `json:"stalePin"`
	Latest   string         `json:"latest"`
	Newer    bool           `json:"newer"`
	Versions []VersionEntry `json:"versions"`
	Err      string         `json:"err,omitempty"`
}

// catalogTimeout bounds the whole read. A version panel that hangs is worse
// than one that says the catalog could not be reached.
const catalogTimeout = 15 * time.Second

// Hub reads the rollback catalog for one install, so no shell holds a copy of
// what "newer", "pinned" or "latest" mean.
func Hub(ctx context.Context, in Install) VersionHub {
	client, err := netclient.NewHTTPClient(ProxySpec(), netclient.TransportOptions{})
	if err != nil {
		hub := VersionHub{Current: in.Version, Pinned: PinnedVersion()}
		hub.Err, hub.Versions = err.Error(), versionRows(nil, in.Version)
		return hub.nonNil()
	}
	return hubOver(ctx, in, client)
}

// hubOver is Hub with the route already decided, so a test can answer the
// catalogs without reaching the network. Where they land is not injectable:
// Studio's catalog is a constant, and a build's own is its release point. Both
// merge newest first, and one that cannot be reached leaves the other's rows
// and the running build's own row standing.
func hubOver(ctx context.Context, in Install, client *http.Client) VersionHub {
	hub := VersionHub{Current: in.Version, Pinned: PinnedVersion()}
	ctx, cancel := context.WithTimeout(ctx, catalogTimeout)
	defer cancel()

	st, err := New(Options{Current: in.Version, Pinned: hub.Pinned, HTTP: client, IndexURL: StudioCatalog, UserAgent: UserAgent(in.Version)}).Check(ctx)
	entries, latest := sourceEntries(st.Entries, ""), st.Latest
	if err != nil {
		hub.Err = err.Error()
	}

	if mine := in.Mine; mine != nil && strings.TrimSpace(mine.URL) != "" {
		opts := Options{Current: in.Version, Pinned: hub.Pinned, HTTP: client, IndexURL: mine.URL, PublicKey: mine.PublicKey, UserAgent: UserAgent(in.Version)}
		mst, merr := New(opts).Check(ctx)
		entries = append(entries, sourceEntries(capEntries(mst.Entries, mine.MaxEntries), mine.Name)...)
		if merr != nil {
			hub.Err = joinCatalogErrors(hub.Err, mine.Name, merr)
		}
		if CompareVersions(mst.Latest, latest) > 0 {
			latest = mst.Latest
		}
	}

	// One offer for the merged list: "newer" is a fact about the versions this
	// panel can install, not about either catalog on its own.
	offer := OfferFor(in.Version, latest, hub.Pinned)
	hub.Latest, hub.Newer, hub.StalePin = latest, offer.Newer, st.StalePin || offer.StalePin
	hub.Versions = versionRowsFor(entries, in.Version)
	return hub.nonNil()
}

// sourcedEntry is one catalog entry with the catalog it came from.
type sourcedEntry struct {
	entry  IndexEntry
	source string
}

func sourceEntries(entries []IndexEntry, source string) []sourcedEntry {
	out := make([]sourcedEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, sourcedEntry{entry: e, source: source})
	}
	return out
}

// capEntries keeps at most max entries (0 = all). A catalog is newest first, so
// a budget drops its oldest rows, never its newest.
func capEntries(entries []IndexEntry, max int) []IndexEntry {
	if max <= 0 || len(entries) <= max {
		return entries
	}
	return entries[:max]
}

// joinCatalogErrors keeps a second catalog's failure visible beside the first,
// named by the source it came from.
func joinCatalogErrors(existing, source string, err error) string {
	line := source + ": " + err.Error()
	if existing == "" {
		return line
	}
	return existing + "; " + line
}

// versionRows merges the running build into the catalog, newest first. The
// running row is always present even when the catalog cannot be read or does
// not carry it (a local build, a release still publishing): it is the panel's
// statement of what runs and its only handle for pinning, so it cannot depend
// on the network.
func versionRows(entries []IndexEntry, current string) []VersionEntry {
	return versionRowsFor(sourceEntries(entries, ""), current)
}

// versionRowsFor is versionRows over entries that remember their catalog, so a
// row can say which release point published it. A version two catalogs both
// carry is listed once, under the first that named it.
func versionRowsFor(entries []sourcedEntry, current string) []VersionEntry {
	rows := make([]VersionEntry, 0, len(entries)+1)
	seen := false
	listed := make(map[string]bool, len(entries))
	for _, s := range entries {
		e := s.entry
		if listed[e.Version] {
			continue
		}
		listed[e.Version] = true
		row := VersionEntry{Version: e.Version, Tag: e.Tag, PublishedAt: e.PublishedAt, Source: s.source, HasNotes: strings.TrimSpace(e.Notes) != ""}
		if SameVersion(e.Version, current) {
			row.Current, seen = true, true
		} else {
			row.Older = e.IsOlderThan(current)
		}
		rows = append(rows, row)
	}
	if !seen && strings.TrimSpace(current) != "" {
		rows = append(rows, VersionEntry{Version: current, Current: true})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return CompareVersions(rows[i].Version, rows[j].Version) > 0
	})
	return rows
}

// nonNil keeps an empty catalog an empty list. A nil slice marshals to null,
// and a client that maps over it crashes its whole render.
func (h VersionHub) nonNil() VersionHub {
	if h.Versions == nil {
		h.Versions = []VersionEntry{}
	}
	return h
}

// PinnedVersion reads the release this machine is held on, or "" when it is
// free to follow the catalog.
func PinnedVersion() string {
	if cfg, err := config.Load(); err == nil && cfg != nil {
		return cfg.DesktopPinnedVersion()
	}
	return ""
}

// Pin holds this machine on a release, or releases the hold when version is
// empty. It is the half of a rollback that outlives the install: without it the
// updater would put the user back on the build they left.
func Pin(version string) error {
	cfg := config.LoadForEdit(config.UserConfigPath())
	if err := cfg.SetDesktopPinnedVersion(version); err != nil {
		return err
	}
	return cfg.SaveTo(config.UserConfigPath())
}

// ReleaseStalePin drops a pin that names a build other than the one running.
// Such a pin holds nobody anywhere: it is what a move that never landed, or an
// install from outside the app, leaves behind. A running build that is not a
// release (a source build says "dev") keeps the pin, since it proves nothing.
func ReleaseStalePin(running string) error {
	pinned := PinnedVersion()
	v := normalizeVersion(running)
	if pinned == "" || SameVersion(pinned, running) || v == "" || v[0] < '0' || v[0] > '9' {
		return nil
	}
	return Pin("")
}

// ProxySpec is the network route updates take, read from config so a machine
// behind a proxy reaches the catalog the same way everything else does.
func ProxySpec() netclient.ProxySpec {
	if cfg, err := config.Load(); err == nil && cfg != nil {
		return cfg.NetworkProxySpec()
	}
	return netclient.ProxySpec{Mode: netclient.ModeAuto}
}
