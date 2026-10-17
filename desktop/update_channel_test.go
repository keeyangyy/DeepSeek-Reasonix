package main

import (
	"testing"

	"reasonix/desktop/internal/update"
)

// The line runs a single update channel, so a manifest may describe a release or
// one of its pre-releases: both shapes are accepted.
func TestManifestChannelAcceptsBothShapes(t *testing.T) {
	for _, version := range []string{"v1.38.54", "v1.38.54-beta.2"} {
		if err := validateManifestChannel("stable", &update.Manifest{Version: version}); err != nil {
			t.Errorf("validateManifestChannel rejected %q: %v", version, err)
		}
	}
	// Unknown shapes stay refused.
	for _, version := range []string{"1.38.54", "v1.38.54-rc.1", "v1.38.54+build.1", "dev", ""} {
		if err := validateManifestChannel("stable", &update.Manifest{Version: version}); err == nil {
			t.Errorf("validateManifestChannel accepted %q", version)
		}
	}
}
