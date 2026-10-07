package main

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"reasonix/internal/agent"
)

// sessionFingerprintSelfHealEnv gates the automatic fingerprint self-heal path.
// It is off unless explicitly enabled, so the behaviour can be observed before
// it becomes the default.
const sessionFingerprintSelfHealEnv = "REASONIX_SESSION_FINGERPRINT_SELFHEAL"

// sessionFingerprintSelfHealEnabled reports whether the self-heal path may run.
func sessionFingerprintSelfHealEnabled() bool {
	return strings.TrimSpace(os.Getenv(sessionFingerprintSelfHealEnv)) == "1"
}

// repairDesktopSessionReadModel refreshes a session's read model. It first gives
// the fingerprint self-heal a chance (only when enabled and the sidecar is
// genuinely stale); otherwise it keeps the pre-existing rebuild behaviour.
//
// phase names the caller so the log line says which path triggered it.
func repairDesktopSessionReadModel(sessionPath, phase string) {
	if strings.TrimSpace(sessionPath) == "" {
		return
	}
	if repairStaleSessionFingerprint(sessionPath) {
		return
	}
	if err := agent.RepairSessionDisplayReadModel(sessionPath); err != nil {
		slog.Debug("desktop: history read-model repair failed", "path", sessionPath, "phase", phase, "err", err)
	}
}

// repairStaleSessionFingerprint handles a session whose authoritative sidecar
// claims an identity that no longer matches its transcript. In that state every
// display-index validation fails, so history paging can stall until the sidecar
// is re-aligned from the transcript.
//
// It returns true only when it took over the session, so callers skip their own
// fallback; false means "not our case, keep the existing behaviour".
//
// Both reads use the same channel the repair path uses, so a mismatch seen here
// is the mismatch the reader would reject. Sessions written by another line or a
// newer build cannot be read at all and are therefore never touched.
func repairStaleSessionFingerprint(sessionPath string) bool {
	if !sessionFingerprintSelfHealEnabled() {
		return false
	}
	if strings.TrimSpace(sessionPath) == "" {
		return false
	}
	meta, metaOK, err := agent.LoadBranchMeta(sessionPath)
	if err != nil || !metaOK {
		return false
	}
	// No authoritative identity to re-align from: leave it to the caller.
	if meta.Revision <= 0 || strings.TrimSpace(meta.ContentDigest) == "" {
		return false
	}
	_, state, repairable, err := agent.LoadSessionDisplayMessages(sessionPath)
	if err != nil || !repairable {
		return false
	}
	contentDigest := strings.TrimSpace(state.DigestHex)
	if contentDigest == "" || contentDigest == strings.TrimSpace(meta.ContentDigest) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := agent.RepairSessionListingProjection(ctx, sessionPath)
	if err != nil {
		slog.Debug("desktop: session fingerprint self-heal failed", "path", sessionPath, "err", err)
		return true
	}
	slog.Info("desktop: session fingerprint self-heal",
		"path", sessionPath, "status", string(result.Status), "ledgerRepaired", result.LedgerRepaired)
	return true
}
