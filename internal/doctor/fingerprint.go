package doctor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"reasonix/internal/agent"
	"reasonix/internal/config"
	"reasonix/internal/store"
)

// SessionFingerprintStatus classifies how a session's authoritative sidecar,
// its derived display index, and its transcript content line up.
type SessionFingerprintStatus string

const (
	// FingerprintOK means sidecar and index describe the current transcript.
	FingerprintOK SessionFingerprintStatus = "ok"
	// FingerprintStaleMeta means the sidecar claims an identity that no longer
	// matches the transcript; every index validation then fails and history
	// paging can stall. This is the shape this doctor exists to find.
	FingerprintStaleMeta SessionFingerprintStatus = "stale-meta"
	// FingerprintStaleIndex means the display index does not validate against
	// an otherwise consistent sidecar.
	FingerprintStaleIndex SessionFingerprintStatus = "stale-index"
	// FingerprintForeignSchema means the session was written by another line or a
	// newer build (event-log schema this build cannot read). Such sessions are
	// never this line's responsibility and must never be repaired here.
	FingerprintForeignSchema SessionFingerprintStatus = "foreign-schema"
	// FingerprintDamaged means the transcript cannot be replayed at all.
	FingerprintDamaged SessionFingerprintStatus = "damaged"
	// FingerprintUnreadable means the files could not be read.
	FingerprintUnreadable SessionFingerprintStatus = "unreadable"
)

// SessionFingerprintReport is one session's three-way fingerprint comparison.
// It is produced by reading only: the scan never writes.
type SessionFingerprintReport struct {
	Path          string                   `json:"path"`
	Status        SessionFingerprintStatus `json:"status"`
	Repairable    bool                     `json:"repairable"`
	FileSize      int64                    `json:"fileSize,omitempty"`
	ContentDigest string                   `json:"contentDigest,omitempty"`
	MetaDigest    string                   `json:"metaDigest,omitempty"`
	MetaRevision  int64                    `json:"metaRevision,omitempty"`
	IndexMissing  bool                     `json:"indexMissing,omitempty"`
	IndexDigest   string                   `json:"indexDigest,omitempty"`
	IndexRevision int64                    `json:"indexRevision,omitempty"`
	IndexKnown    bool                     `json:"indexRevisionKnown"`
	IndexValid    bool                     `json:"indexValid"`
	Note          string                   `json:"note,omitempty"`
}

// AnalyzeSessionFingerprint compares one session's sidecar, display index, and
// content digest. The content digest comes from the same read channel the
// repair path uses (loadSessionDisplayMessages), so a mismatch reported here is
// the same mismatch the reader would reject.
func AnalyzeSessionFingerprint(path string) SessionFingerprintReport {
	report := SessionFingerprintReport{Path: path}
	info, err := os.Stat(path)
	if err != nil {
		report.Status = FingerprintUnreadable
		report.Note = err.Error()
		return report
	}
	report.FileSize = info.Size()

	_, state, repairable, err := agent.LoadSessionDisplayMessages(path)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "schema") {
			report.Status = FingerprintForeignSchema
			report.Note = "written by another line or a newer build; not this line's session"
			return report
		}
		report.Status = FingerprintUnreadable
		report.Note = err.Error()
		return report
	}
	report.Repairable = repairable
	report.ContentDigest = strings.TrimSpace(state.DigestHex)

	meta, metaOK, err := agent.LoadBranchMeta(path)
	if err != nil {
		report.Status = FingerprintUnreadable
		report.Note = err.Error()
		return report
	}
	if metaOK {
		report.MetaDigest = strings.TrimSpace(meta.ContentDigest)
		report.MetaRevision = meta.Revision
	}

	idx, err := agent.LoadSessionDisplayIndex(store.SessionDisplayIndex(path))
	if err != nil || idx == nil {
		report.IndexMissing = true
	} else {
		report.IndexDigest = strings.TrimSpace(idx.ContentDigest)
		report.IndexRevision = idx.Revision
		report.IndexKnown = idx.RevisionKnown
		if metaOK {
			if digest, ok := parseFingerprintDigest(report.MetaDigest); ok {
				report.IndexValid = agent.ValidateSessionDisplayIndex(idx, meta.Revision, true, digest, report.FileSize)
			}
		}
	}

	if !repairable {
		report.Status = FingerprintDamaged
		report.Note = "transcript cannot be replayed"
		return report
	}
	if metaOK && meta.Revision > 0 && report.MetaDigest != "" && report.MetaDigest != report.ContentDigest {
		report.Status = FingerprintStaleMeta
		report.Note = "sidecar content_digest does not match the transcript"
		return report
	}
	if !report.IndexValid {
		report.Status = FingerprintStaleIndex
		report.Note = "display index does not validate against the sidecar"
		return report
	}
	report.Status = FingerprintOK
	return report
}

// SessionFingerprintRoots lists the directories that hold session transcripts:
// the global session directory plus every project's session directory.
func SessionFingerprintRoots() []string {
	home := strings.TrimSpace(config.ReasonixHomeDir())
	if home == "" {
		return nil
	}
	roots := []string{filepath.Join(home, "sessions")}
	if entries, err := os.ReadDir(filepath.Join(home, "projects")); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				roots = append(roots, filepath.Join(home, "projects", entry.Name(), "sessions"))
			}
		}
	}
	sort.Strings(roots)
	return roots
}

// ScanSessionFingerprints analyzes every transcript below the given roots.
func ScanSessionFingerprints(roots []string) []SessionFingerprintReport {
	reports := []SessionFingerprintReport{}
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !store.IsSessionTranscriptName(entry.Name()) {
				continue
			}
			reports = append(reports, AnalyzeSessionFingerprint(filepath.Join(root, entry.Name())))
		}
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Path < reports[j].Path })
	return reports
}

// RenderFingerprintText renders a human-readable scan summary. Only sessions
// that need attention are listed in detail.
func RenderFingerprintText(reports []SessionFingerprintReport) string {
	counts := map[SessionFingerprintStatus]int{}
	for _, report := range reports {
		counts[report.Status]++
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Reasonix session fingerprints\n")
	fmt.Fprintf(&b, "  scanned: %d\n", len(reports))
	fmt.Fprintf(&b, "  ok: %d  stale-meta: %d  stale-index: %d  foreign-schema: %d  damaged: %d  unreadable: %d\n",
		counts[FingerprintOK], counts[FingerprintStaleMeta], counts[FingerprintStaleIndex],
		counts[FingerprintForeignSchema], counts[FingerprintDamaged], counts[FingerprintUnreadable])
	for _, report := range reports {
		if report.Status == FingerprintOK {
			continue
		}
		fmt.Fprintf(&b, "\n  [%s] %s\n", report.Status, report.Path)
		if report.Note != "" {
			fmt.Fprintf(&b, "      %s\n", report.Note)
		}
		fmt.Fprintf(&b, "      content=%s\n", shortFingerprintDigest(report.ContentDigest))
		fmt.Fprintf(&b, "      meta=%s rev=%d\n", shortFingerprintDigest(report.MetaDigest), report.MetaRevision)
		fmt.Fprintf(&b, "      index=%s rev=%d known=%v valid=%v missing=%v\n",
			shortFingerprintDigest(report.IndexDigest), report.IndexRevision, report.IndexKnown, report.IndexValid, report.IndexMissing)
	}
	return b.String()
}

// SessionFingerprintRepairResult reports what one repair attempt did (or, in
// dry-run mode, what it would do).
type SessionFingerprintRepairResult struct {
	Path   string `json:"path"`
	DryRun bool   `json:"dryRun"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// RepairStaleSessionFingerprints repairs every session whose sidecar
// fingerprint does not match its transcript. It reuses the runtime's own repair
// entry point (RepairSessionListingProjection), which rewrites the sidecar and
// display index from the transcript; the transcript content itself is not
// semantically changed. In dry-run mode nothing is written.
func RepairStaleSessionFingerprints(ctx context.Context, reports []SessionFingerprintReport, dryRun bool) []SessionFingerprintRepairResult {
	results := []SessionFingerprintRepairResult{}
	for _, report := range reports {
		if report.Status != FingerprintStaleMeta {
			continue
		}
		if dryRun {
			results = append(results, SessionFingerprintRepairResult{
				Path: report.Path, DryRun: true, Status: "would-repair",
				Detail: fmt.Sprintf("meta %s rev %d != content %s",
					shortFingerprintDigest(report.MetaDigest), report.MetaRevision, shortFingerprintDigest(report.ContentDigest)),
			})
			continue
		}
		repairCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, err := agent.RepairSessionListingProjection(repairCtx, report.Path)
		cancel()
		switch {
		case err != nil:
			results = append(results, SessionFingerprintRepairResult{Path: report.Path, Status: "error", Detail: err.Error()})
		default:
			results = append(results, SessionFingerprintRepairResult{
				Path: report.Path, Status: string(result.Status),
				Detail: fmt.Sprintf("ledgerRepaired=%v", result.LedgerRepaired),
			})
		}
	}
	return results
}

// RenderFingerprintRepairText renders the repair outcome summary.
func RenderFingerprintRepairText(results []SessionFingerprintRepairResult, dryRun bool) string {
	var b strings.Builder
	if dryRun {
		fmt.Fprintf(&b, "Reasonix session fingerprint repair (dry run)\n")
	} else {
		fmt.Fprintf(&b, "Reasonix session fingerprint repair\n")
	}
	counts := map[string]int{}
	for _, result := range results {
		counts[result.Status]++
	}
	fmt.Fprintf(&b, "  candidates: %d\n", len(results))
	for _, result := range results {
		fmt.Fprintf(&b, "\n  [%s] %s\n", result.Status, result.Path)
		if result.Detail != "" {
			fmt.Fprintf(&b, "      %s\n", result.Detail)
		}
	}
	if dryRun && len(results) == 0 {
		fmt.Fprintf(&b, "  nothing to repair\n")
	}
	return b.String()
}

func parseFingerprintDigest(text string) ([sha256.Size]byte, bool) {
	var out [sha256.Size]byte
	text = strings.TrimSpace(text)
	if text == "" {
		return out, false
	}
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != sha256.Size {
		return out, false
	}
	copy(out[:], raw)
	return out, true
}

func shortFingerprintDigest(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return "(none)"
	}
	if len(text) > 10 {
		return text[:10]
	}
	return text
}
