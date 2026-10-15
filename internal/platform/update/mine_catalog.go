package update

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

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

// forkPublicKey is the minisign public key this fork's own Studio releases are
// signed with (Key ID 238315CA90ACADED). A build that reads a second catalog
// beside Studio's accepts artifacts under that catalog's key, so an entry can
// only install what the key it names vouches for. The private half lives in
// this fork's CI secrets and nowhere else.
const forkPublicKey = `untrusted comment: minisign public key: 238315CA90ACADED
RWTtrayQyhWDI8VYPakDFeST7JhS0rqq2HzMRV9wkMDmYSR+y5qUAVnG`

// ForkPublicKey returns this fork's own signing key in its canonical two-line
// text form, the counterpart of PublicKey for the second catalog.
func ForkPublicKey() string { return forkPublicKey }

// VerifyWithSource checks sig over data under the key a catalog declared,
// falling back to Studio's own key when the source named none. A source that
// names no key is read as Studio's, never as "any signature will do".
func VerifyWithSource(key string, data, sig []byte) error {
	if strings.TrimSpace(key) == "" {
		return Verify(data, sig)
	}
	return verifyWith(key, data, sig)
}

// sourcedEntry is one catalog entry with the catalog it came from.
type sourcedEntry struct {
	entry  IndexEntry
	source string
}

// sourceEntries stamps every entry with the catalog that published it.
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

// catalogRead is what reading every catalog a build declares produced: entries
// that remember their source, the newest version any of them lists, and the
// failures, each named by the catalog that failed.
type catalogRead struct {
	entries   []sourcedEntry
	latest    string
	newer     bool
	stalePin  bool
	withdrawn *WithdrawnNote
	err       string
}

// readCatalogs reads Studio's catalog and, where the build declares one, its
// own beside it. Where either lands is not a caller's choice: Studio's is a
// constant, and a build's own is the release point it ships with. A second
// catalog that cannot be reached costs its own rows and nothing else, so what
// runs and what Studio published stay on screen.
func readCatalogs(ctx context.Context, in Install, pinned string, client *http.Client) catalogRead {
	out := catalogRead{}
	st, err := New(Options{Current: in.Version, Pinned: pinned, HTTP: client, IndexURL: StudioCatalog, UserAgent: UserAgent(in.Version)}).Check(ctx)
	out.entries, out.latest, out.stalePin = sourceEntries(st.Entries, ""), st.Latest, st.StalePin
	if st.Withdrawn != nil {
		out.withdrawn = &WithdrawnNote{Version: st.Withdrawn.Version, Reason: st.Withdrawn.Reason}
	}
	if err != nil {
		out.err = err.Error()
	}
	mine := in.Mine
	if mine == nil || strings.TrimSpace(mine.URL) == "" || mine.URL == StudioCatalog {
		return out.settled(in.Version, pinned)
	}
	mst, merr := New(Options{Current: in.Version, Pinned: pinned, HTTP: client, IndexURL: mine.URL, PublicKey: mine.PublicKey, UserAgent: UserAgent(in.Version)}).Check(ctx)
	out.entries = append(out.entries, sourceEntries(capEntries(mst.Entries, mine.MaxEntries), mine.Name)...)
	if merr != nil {
		out.err = joinCatalogErrors(out.err, mine.Name, merr)
	}
	if CompareVersions(mst.Latest, out.latest) > 0 {
		out.latest = mst.Latest
	}
	return out.settled(in.Version, pinned)
}

// settled decides what the merged list offers: "newer" is a fact about the
// versions this panel can install, not about either catalog on its own.
func (r catalogRead) settled(current, pinned string) catalogRead {
	offer := OfferFor(current, r.latest, pinned)
	r.newer = offer.Newer
	r.stalePin = r.stalePin || offer.StalePin
	return r
}

// manifestFor is ManifestFor across every catalog this updater declares. The
// version is answered by the catalog that lists it, and the manifest remembers
// that catalog's key: a build's own releases are verified against the build's
// key, and only the catalog that named a version may vouch for its bytes.
func (u *Updater) manifestFor(ctx context.Context, version string) (*Manifest, error) {
	idx, err := FetchIndex(ctx, u.opts.HTTP, u.opts.IndexURL, u.opts.UserAgent)
	if err != nil {
		return nil, err
	}
	if w, gone := idx.WithdrawnVersion(version); gone {
		return nil, fmt.Errorf("%w: %s", ErrWithdrawn, w.Version)
	}
	m, err := u.manifestIn(ctx, idx.Versions, version, u.opts.PublicKey)
	if err != nil || m != nil {
		return m, err
	}
	if mine := u.opts.Mine; mine != nil && mine.URL != "" && mine.URL != u.opts.IndexURL {
		idx, err := FetchIndex(ctx, u.opts.HTTP, mine.URL, u.opts.UserAgent)
		if err != nil {
			return nil, err
		}
		if w, gone := idx.WithdrawnVersion(version); gone {
			return nil, fmt.Errorf("%w: %s", ErrWithdrawn, w.Version)
		}
		m, err := u.manifestIn(ctx, idx.Versions, version, mine.PublicKey)
		if err != nil || m != nil {
			return m, err
		}
	}
	return nil, fmt.Errorf("update: %s is not in the published catalog", version)
}

// manifestIn resolves version out of one catalog's entries, remembering the key
// that catalog signs with. A nil manifest and nil error means this catalog does
// not list it.
func (u *Updater) manifestIn(ctx context.Context, entries []IndexEntry, version, key string) (*Manifest, error) {
	for _, e := range entries {
		if !SameVersion(e.Version, version) {
			continue
		}
		m, err := FetchManifestAt(ctx, u.opts.HTTP, e.Manifest, u.opts.UserAgent)
		if err != nil {
			return nil, err
		}
		// The catalog says this tag holds that version; the manifest under it has
		// to agree, or a mis-published row would install a build the user never
		// picked from the list.
		if !SameVersion(m.Version, version) {
			return nil, fmt.Errorf("update: %s resolves to a manifest for %s", version, m.Version)
		}
		m.sourceKey = key
		return m, nil
	}
	return nil, nil
}

// artifactKey is the key that verifies m's artifacts: the one the catalog that
// published it signs with, or this updater's own when the manifest came from a
// catalog that named none.
func (u *Updater) artifactKey(m *Manifest) string {
	if m != nil && m.sourceKey != "" {
		return m.sourceKey
	}
	return u.opts.PublicKey
}
