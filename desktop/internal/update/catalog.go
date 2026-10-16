package update

// Catalog is the versions.json this line publishes on its update anchor. It
// lists the releases the update panel may offer, newest first, and each entry
// points at that version's own immutable manifest — so installing an older or
// pre-release build verifies through exactly the same path a forward update
// does, instead of trusting a moving anchor.
//
// A catalog is additive history: the release workflow merges each new version
// in and trims only what the panel shows, so an entry published earlier is
// never rewritten by a later release.
type Catalog struct {
	SchemaVersion int            `json:"schemaVersion"`
	UpdatedAt     string         `json:"updatedAt,omitempty"`
	Versions      []CatalogEntry `json:"versions"`
}

// CatalogEntry is one released version, as the release workflow records it.
type CatalogEntry struct {
	Version     string `json:"version"` // e.g. "v1.38.54" or "v1.38.54-beta.2"
	Tag         string `json:"tag"`     // git tag the release lives under
	Channel     string `json:"channel"` // ChannelStable | ChannelBeta
	PublishedAt string `json:"publishedAt,omitempty"`
	Manifest    string `json:"manifest"`        // that version's own latest.json
	Notes       string `json:"notes,omitempty"` // optional release-notes object
}

// Channels a catalog entry carries. The release workflow decides the value from
// the tag's shape, and catalogfilter uses it to decide what the panel lists.
const (
	ChannelStable = "stable"
	ChannelBeta   = "beta"
)
