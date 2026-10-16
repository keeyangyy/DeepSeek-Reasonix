package main

import (
	"log/slog"
	"reasonix/internal/agent"
	"reasonix/internal/control"
)

func delayedDesktopTopicRemove(sessionPath string, guard *agent.SessionRemovalGuard, destroys []control.SessionDestroyHandle) {
	waitAllDestroyHandles(destroys)
	if err := removeDesktopSessionArtifactsWithGuard(sessionPath, guard); err != nil {
		slog.Warn("desktop: delayed topic removal remains pending")
	}
	finishDestroyHandles(destroys)
}
