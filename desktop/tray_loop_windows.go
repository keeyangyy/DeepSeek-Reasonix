//go:build windows

package main

import (
	"log/slog"
	"os"
	"runtime"

	"fyne.io/systray"
	"reasonix/desktop/internal/instanceidentity"
)

// trayIdentity returns the shell GUID that keeps the notification-area
// preference when the executable moves between versions/<version>/ directories.
// Authenticode is not consulted: this fork ships unsigned builds, and the GUID
// carries only a visibility preference. Deriving it per data home keeps
// independent instances apart.
func trayIdentity(dev, exe, id string) string {
	if dev != "" || exe == "" {
		return ""
	}
	return instanceidentity.TrayGUID(id)
}

func startDesktopTray(onReady, onExit func()) func() {
	go runDesktopTrayLoop(func() {
		exe, _ := os.Executable()
		if id := trayIdentity(os.Getenv("REASONIX_DEV"), exe, singleInstanceID()); id != "" {
			if err := systray.SetIconID(id); err != nil {
				slog.Warn("desktop: configure tray identity", "err", err)
			}
		}
		systray.Run(onReady, onExit)
	})
	return systray.Quit
}

func runDesktopTrayLoop(run func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	run()
}
