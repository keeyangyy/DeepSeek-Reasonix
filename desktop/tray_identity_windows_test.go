//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows"

	"reasonix/desktop/internal/instanceidentity"
)

func TestTrayIdentitySkipsDevelopmentAndMissingExecutable(t *testing.T) {
	id := instanceidentity.ForHome(t.TempDir())
	for _, tc := range []struct {
		name, dev, exe string
		wantGUID       bool
	}{
		{name: "installed", exe: "desktop.exe", wantGUID: true},
		{name: "unsigned", exe: "desktop.exe", wantGUID: true},
		{name: "development", dev: "1", exe: "desktop.exe"},
		{name: "missing executable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := trayIdentity(tc.dev, tc.exe, id)
			if (got != "") != tc.wantGUID {
				t.Fatalf("guid=%q", got)
			}
			if got == "" {
				return
			}
			if _, err := windows.GUIDFromString(got); err != nil {
				t.Fatal(err)
			}
			if got != instanceidentity.TrayGUID(id) {
				t.Fatal("wrong identity")
			}
		})
	}
}
