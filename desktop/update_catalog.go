package main

// The version catalog: versions.json, published on the same anchor as
// latest.json. The panel lists installable versions from it; the anchor itself
// describes whatever was published most recently (a release or a pre-release).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"reasonix/desktop/internal/update"
)

// githubCatalogFallback is the version catalog's fixed address. It sits on the
// same anchor release as the manifest, which every release rewrites.
const githubCatalogFallback = "https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/wails-latest/versions.json"

// channelOfVersion derives an entry's channel from its version shape, matching
// how the release workflow decides the field it records in the catalog.
func channelOfVersion(v string) string {
	if strings.Contains(v, "-beta.") {
		return update.ChannelBeta
	}
	return update.ChannelStable
}

func catalogEndpoints() []string {
	return withMirrors([]string{githubCatalogFallback})
}

// fetchCatalog reads the catalog from the line's own endpoints.
func fetchCatalog(ctx context.Context, c, fallback *http.Client, selected string) (*update.Catalog, error) {
	return fetchCatalogFrom(ctx, c, fallback, selected, catalogEndpoints())
}

// fetchCatalogFrom pulls versions.json from each URL in order until one both
// responds and decodes to a non-empty catalog. Every failure is kept: a user
// staring at a proxy error needs to see which source died, not just the last.
func fetchCatalogFrom(ctx context.Context, c, fallback *http.Client, selected string, urls []string) (*update.Catalog, error) {
	var errs []error
	for _, url := range urls {
		endpointCtx, cancel := context.WithTimeout(ctx, manifestEndpointTimeout)
		b, err := fetchManifestBytes(endpointCtx, c, fallback, selected, url)
		cancel()
		if err != nil {
			errs = append(errs, err)
			continue
		}
		var cat update.Catalog
		if err := json.Unmarshal(b, &cat); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", url, err))
			continue
		}
		if len(cat.Versions) == 0 {
			errs = append(errs, fmt.Errorf("%s: catalog lists no versions", url))
			continue
		}
		return &cat, nil
	}
	return nil, fmt.Errorf("update: fetch catalog: %w", errors.Join(errs...))
}

// UpdateVersion is one row of the update panel's version list.
type UpdateVersion struct {
	Version     string `json:"version"`
	Channel     string `json:"channel"`
	PublishedAt string `json:"publishedAt,omitempty"`
	Current     bool   `json:"current"`
	Installable bool   `json:"installable"`
	ManifestURL string `json:"manifestUrl"`
}

// UpdateVersionList is the panel's payload: the running build, how this install
// can update at all, and every version the catalog offers. The install-profile
// fields are list-level because they describe the machine, not one version. Err
// is reported in the payload instead of failing the call, so a startup check
// can stay quiet on a network error.
type UpdateVersionList struct {
	Current           string          `json:"current"`
	CanSelfUpdate     bool            `json:"canSelfUpdate"`
	ManualReason      string          `json:"manualReason,omitempty"`
	InstallMode       string          `json:"installMode,omitempty"`
	RequiresElevation bool            `json:"requiresElevation,omitempty"`
	Entries           []UpdateVersion `json:"entries"`
	Err               string          `json:"err,omitempty"`
}

// ListUpdateVersions reports the versions the update panel may offer. It reads
// the catalog rather than the manifest anchor, so pre-releases are listable
// while the stable channel's own check keeps rejecting a pre-release manifest.
func (a *App) ListUpdateVersions(selectedChannel string) (*UpdateVersionList, error) {
	selectedChannel = targetUpdateChannel(selectedChannel)
	profile := detectInstallProfile()
	out := &UpdateVersionList{
		Current:           version,
		CanSelfUpdate:     profile.CanSelfUpdate && canSelfUpdate(),
		ManualReason:      firstNonEmptyStr(profile.ManualReason, manualUpdateReason()),
		InstallMode:       profile.Mode,
		RequiresElevation: profile.RequiresElev,
		Entries:           []UpdateVersion{},
	}
	c, err := httpClient()
	if err != nil {
		out.Err = err.Error()
		return out, nil
	}
	ctx, cancel := context.WithTimeout(a.reqCtx(), httpTimeout)
	defer cancel()
	v4, _ := httpClientIPv4()
	cat, err := fetchCatalog(ctx, c, v4, selectedChannel)
	if err != nil {
		out.Err = err.Error()
		return out, nil
	}
	current, okCurrent := normalizeVersion(version)
	for _, e := range cat.Versions {
		v, ok := normalizeVersion(e.Version)
		if !ok {
			continue
		}
		entry := UpdateVersion{
			Version:     v,
			Channel:     firstNonEmptyStr(e.Channel, channelOfVersion(v)),
			PublishedAt: e.PublishedAt,
			Current:     okCurrent && v == current,
			ManifestURL: e.Manifest,
		}
		entry.Installable = !entry.Current
		out.Entries = append(out.Entries, entry)
	}
	return out, nil
}

// releaseDownloadBase is the only place this line's release assets live. A
// catalog entry's manifest URL must stay under it: the manifest itself is
// signature-verified, but an arbitrary address would still let a hostile
// catalog make the app fetch from somewhere else.
const releaseDownloadBase = "https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/"

func validateCatalogManifestURL(u string) error {
	if !strings.HasPrefix(u, releaseDownloadBase) || !strings.HasSuffix(u, "/latest.json") {
		return fmt.Errorf("update: catalog manifest URL %q is not under the release download base", u)
	}
	return nil
}

// resolveUpdateManifest returns the manifest describing wantVersion. The anchor
// answers for the current release; anything else — an older or pre-release
// build the user picked from the list — is looked up in the catalog and fetched
// from that version's own address, where the version shape may be a
// pre-release. The bool reports which path answered.
func resolveUpdateManifest(ctx context.Context, c, fallback *http.Client, selected, wantVersion string) (*update.Manifest, bool, error) {
	return resolveUpdateManifestWith(ctx, c, fallback, selected, wantVersion,
		manifestEndpoints(normalizeUpdateChannel(selected)), catalogEndpoints())
}

// resolveUpdateManifestWith is resolveUpdateManifest with its two source lists
// injected, so both paths can be exercised without the network.
func resolveUpdateManifestWith(ctx context.Context, c, fallback *http.Client, selected, wantVersion string, anchorURLs, catalogURLs []string) (*update.Manifest, bool, error) {
	anchor, anchorErr := fetchManifestAnchored(ctx, c, fallback, selected, anchorURLs)
	if anchorErr == nil && anchor.Version == wantVersion {
		return anchor, false, nil
	}
	cat, catErr := fetchCatalogFrom(ctx, c, fallback, selected, catalogURLs)
	if catErr != nil {
		if anchorErr != nil {
			return nil, false, anchorErr
		}
		return nil, false, fmt.Errorf("update: %s is not the current release and the catalog is unreachable: %w", wantVersion, catErr)
	}
	for _, e := range cat.Versions {
		if e.Version != wantVersion || strings.TrimSpace(e.Manifest) == "" {
			continue
		}
		if err := validateCatalogManifestURL(e.Manifest); err != nil {
			return nil, false, err
		}
		m, err := fetchManifestFrom(ctx, c, fallback, selected, e.Manifest, validateDesktopManifest)
		if err != nil {
			return nil, false, err
		}
		if m.Version != wantVersion {
			return nil, false, fmt.Errorf("update: catalog entry %s served manifest %s", wantVersion, m.Version)
		}
		return m, true, nil
	}
	if anchorErr != nil {
		return nil, false, anchorErr
	}
	return nil, false, fmt.Errorf("update: %s is neither the current release nor listed in the catalog", wantVersion)
}

// fetchManifestAnchored tries each anchor URL in order, accepting the first one
// that responds, decodes, and passes the channel's manifest rule.
func fetchManifestAnchored(ctx context.Context, c, fallback *http.Client, selected string, urls []string) (*update.Manifest, error) {
	var errs []error
	for _, url := range urls {
		m, err := fetchManifestFrom(ctx, c, fallback, selected, url, validateDesktopManifest)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		return m, nil
	}
	return nil, fmt.Errorf("update: fetch manifest: %w", errors.Join(errs...))
}

// fetchManifestFrom reads one manifest URL and validates it with the supplied
// rule, so an explicit-version install can use the catalog entry's own address
// under the same asset checks.
func fetchManifestFrom(ctx context.Context, c, fallback *http.Client, selected, url string, validate func(string, *update.Manifest) error) (*update.Manifest, error) {
	endpointCtx, cancel := context.WithTimeout(ctx, manifestEndpointTimeout)
	defer cancel()
	b, err := fetchManifestBytes(endpointCtx, c, fallback, selected, url)
	if err != nil {
		return nil, err
	}
	var m update.Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	if err := validate(selected, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	return &m, nil
}
