package agent

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"reasonix/internal/evidence"
	"reasonix/internal/provider"
)

// A digest carries what the fold changed and what failed; everything else
// becomes prose or nothing, and the model cannot tell which. An index line
// says what prose cannot: this happened, and here is where it still is.

// The heading carries its own legend; a separate explanatory line would be
// fixed overhead on every digest for the rest of the session.
const indexSectionHeading = "## Folded work index (#n = transcript position)"

// foldIndexEntry is one folded item reduced to a line.
type foldIndexEntry struct {
	Canonical int    // position in the canonical transcript, or -1 when unknown
	Kind      string // "you" | tool name
	Subject   string // path, command, or a user turn's opening words
	Note      string // "dropped"/"failed" annotation, else ""
	rank      int    // lower survives the budget first
}

func (e foldIndexEntry) line() string {
	var b strings.Builder
	if e.Canonical >= 0 {
		fmt.Fprintf(&b, "#%d ", e.Canonical)
	}
	b.WriteString(e.Kind)
	if e.Subject != "" {
		b.WriteString("  " + e.Subject)
	}
	if e.Note != "" {
		b.WriteString("  (" + e.Note + ")")
	}
	return "- " + b.String()
}

// Ranks order what survives a bounded index. A user turn the budget could not
// hold comes first: its original is words nobody can re-derive. Failed
// exploration outranks a plain read — a path already tried is worth more.
const (
	rankDroppedUserTurn = iota
	rankFailedCall
	rankCommand
	rankRead
)

// foldIndexToolFailed reports a tool result the transcript itself marks failed:
// host-recorded execution state first, the historical error prefixes second.
func foldIndexToolFailed(m provider.Message) bool {
	if m.ToolExecution != nil && m.ToolExecution.ExitCode != nil && *m.ToolExecution.ExitCode != 0 {
		return true
	}
	return toolResultFailed(m.Content)
}

// buildFoldIndex reduces the fold region to index lines. keptAt reports region
// positions the projection still shows verbatim. origin maps a region position
// to its canonical index, or -1 for a message already folded once.
func buildFoldIndex(region []provider.Message, keptAt func(int) bool, origin func(int) int) []foldIndexEntry {
	var out []foldIndexEntry
	calls := map[string]provider.ToolCall{}
	callAt := map[string]int{}
	for i, m := range region {
		for _, tc := range m.ToolCalls {
			calls[tc.ID] = tc
			callAt[tc.ID] = i
		}
		if m.LocalOnly || IsPinnedContextRevision(m) {
			continue
		}
		switch {
		case m.Role == provider.RoleUser && !isCompactionSummary(m):
			if keptAt != nil && keptAt(i) {
				continue // held verbatim; the projection still shows it
			}
			out = append(out, foldIndexEntry{
				Canonical: origin(i), Kind: "you", Subject: quotedOpening(m.Content),
				Note: "summary only", rank: rankDroppedUserTurn,
			})
		case m.Role == provider.RoleTool:
			if keptAt != nil && keptAt(i) {
				continue // held verbatim; the projection still shows it
			}
			call, ok := calls[m.ToolCallID]
			if !ok {
				continue
			}
			failed := foldIndexToolFailed(m)
			// readOnly=false keeps path extraction on for read tools too: an
			// index line wants the file a read touched, not its body.
			rec := evidence.ReceiptFromToolCall(call.Name, json.RawMessage(call.Arguments), !failed, false)
			entry := foldIndexEntry{Canonical: origin(callAt[m.ToolCallID]), Kind: call.Name, rank: rankRead}
			switch {
			case rec.Command != "":
				entry.Subject, entry.rank = firstLine(rec.Command), rankCommand
			case len(rec.Paths) > 0:
				entry.Subject = strings.Join(rec.Paths, " ")
			default:
				entry.Subject = summarizeToolArgs(call.Arguments)
			}
			if failed {
				entry.Note, entry.rank = "failed", rankFailedCall
			}
			out = append(out, entry)
		}
	}
	return out
}

// renderFoldIndex writes the section, dropping the lowest-ranked entries when
// the budget binds. Ties keep transcript order so the section reads forward.
func renderFoldIndex(entries []foldIndexEntry, budgetTokens int) string {
	if len(entries) == 0 || budgetTokens <= 0 {
		return ""
	}
	var chosen []int
	spent := estimateTextTokens(indexSectionHeading)
	for rank := rankDroppedUserTurn; rank <= rankRead; rank++ {
		for i := range entries {
			if entries[i].rank != rank {
				continue
			}
			cost := estimateTextTokens(entries[i].line())
			if spent+cost > budgetTokens {
				continue
			}
			spent += cost
			chosen = append(chosen, i)
		}
	}
	if len(chosen) == 0 {
		return ""
	}
	keep := make([]bool, len(entries))
	for _, i := range chosen {
		keep[i] = true
	}
	var b strings.Builder
	b.WriteString(indexSectionHeading + "\n")
	for i, e := range entries {
		if keep[i] {
			b.WriteString(e.line() + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// splitFoldIndex separates a digest's prose from the index section this package
// appended to it. Keeping them apart is what lets a later fold re-summarize the
// prose without asking a model to rewrite lines it never wrote.
func splitFoldIndex(digest string) (prose, index string) {
	i := strings.Index(digest, indexSectionHeading)
	if i < 0 {
		return digest, ""
	}
	return strings.TrimRight(digest[:i], "\n "), strings.TrimSpace(digest[i:])
}

// foldIndexLinePattern matches one host-written index line by its full shape:
// an address, then a kind that is always "you" or a lowercase tool name. The
// kind anchor is what keeps the pattern off prose that merely cites "#12".
var foldIndexLinePattern = regexp.MustCompile(`^- #\d+ (?:you|[a-z][a-z0-9_]*)(?:\s|$)`)

// stripIndexLines removes index-shaped lines a model copied into a digest
// despite the instruction not to. It is the second defence after the heading
// split: entries absorbed as bare lines have no heading to cut on. A line of
// prose misread as an index line costs one bullet; the host index is appended
// after, so an address is never lost to a false positive.
func stripIndexLines(text string) string {
	if !strings.Contains(text, "#") {
		return text
	}
	var b strings.Builder
	dropped := false
	for line := range strings.SplitSeq(text, "\n") {
		if foldIndexLinePattern.MatchString(strings.TrimRight(line, " ")) {
			dropped = true
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	if !dropped {
		return text
	}
	return strings.TrimRight(b.String(), "\n")
}

// priorFoldIndexFrom reads the index section out of any summary already inside
// the fold, without touching the fold itself: this line keeps the summary
// request byte-stable against the previous turn (the cache prefix the host
// reuses), so the index travels into the request as ordinary prose and the
// merged index comes back appended by the host, never rewritten by the model.
func priorFoldIndexFrom(fold []provider.Message) string {
	var carried []string
	for _, m := range fold {
		if !isCompactionSummary(m) {
			continue
		}
		if _, index := splitFoldIndex(m.Content); index != "" {
			carried = append(carried, index)
		}
	}
	return strings.Join(carried, "\n")
}

// mergeFoldIndex carries the previous index forward ahead of the new lines and
// trims from the oldest when the budget binds — an entry that has survived more
// folds is the one whose original is furthest out of reach.
func mergeFoldIndex(previous, fresh string, budgetTokens int) string {
	previous, fresh = strings.TrimSpace(previous), strings.TrimSpace(fresh)
	if previous == "" {
		return fresh
	}
	lines := append(indexBodyLines(previous), indexBodyLines(fresh)...)
	if len(lines) == 0 {
		return ""
	}
	spent := estimateTextTokens(indexSectionHeading)
	first := 0
	for i, line := range slices.Backward(lines) {
		cost := estimateTextTokens(line)
		if spent+cost > budgetTokens {
			first = i + 1
			break
		}
		spent += cost
	}
	if first >= len(lines) {
		return ""
	}
	var b strings.Builder
	b.WriteString(indexSectionHeading + "\n")
	if first > 0 {
		fmt.Fprintf(&b, "- (%d older entries dropped; %s)\n", first, droppedIndexHint)
	}
	for _, l := range lines[first:] {
		b.WriteString(l + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

const droppedIndexHint = "recall with a query still finds them"

func indexBodyLines(section string) []string {
	var out []string
	for line := range strings.SplitSeq(section, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if strings.HasPrefix(trimmed, "- ") && !strings.HasPrefix(trimmed, "- (") {
			out = append(out, trimmed)
		}
	}
	return out
}

// quotedOpening is a user turn reduced to enough words to recognise it.
func quotedOpening(content string) string {
	const maxRunes = 60
	flat := strings.Join(strings.Fields(strings.TrimSpace(content)), " ")
	if flat == "" {
		return ""
	}
	runes := []rune(flat)
	if len(runes) > maxRunes {
		flat = string(runes[:maxRunes]) + "…"
	}
	return strconv.Quote(flat)
}

// foldIndexBudget is the index's share of a checkpoint. A line costs about a
// dozen tokens, so one percent of the window addresses roughly a hundred items
// — shared by every generation, since the index is cumulative.
func (a *Agent) foldIndexBudget() int {
	const floor = 256
	window := a.effectiveContextWindow()
	if window <= 0 {
		return floor
	}
	return max(floor, window/100)
}

// attachFoldIndex appends the merged index to a digest.
func (a *Agent) attachFoldIndex(digest, priorIndex string, entries []foldIndexEntry) string {
	budget := a.foldIndexBudget()
	merged := mergeFoldIndex(priorIndex, renderFoldIndex(entries, budget), budget)
	if merged == "" {
		return digest
	}
	return strings.TrimRight(digest, "\n") + "\n\n" + merged
}

// canonicalOriginFor maps a fold-region position back to its place in the
// canonical transcript, which is what an index address has to name. Positions
// inside a previous projection have no canonical address of their own — that
// content was already folded once — so they answer -1.
func canonicalOriginFor(state CompactionState, canonical, view []provider.Message, head int) func(int) int {
	projected := len(state.Projection.Messages)
	// The view is either canonical itself, or the projection spliced with
	// canonical[CoveredCount:]. The two cases differ only in where the
	// canonical run begins.
	if projected == 0 || len(view) == 0 || projected > len(view) {
		return func(i int) int {
			if pos := head + i; pos < len(canonical) {
				return pos
			}
			return -1
		}
	}
	covered := state.Projection.CoveredCount
	return func(i int) int {
		pos := head + i
		if pos < projected {
			return -1
		}
		if origin := covered + (pos - projected); origin < len(canonical) {
			return origin
		}
		return -1
	}
}

// compressFoldIndexRegion derives the fold region and kept-mask for the
// explicit compression path from its plan masks. Kept means the projection
// still shows the message verbatim: neither folded into the digest nor dropped.
// A nil region means the plan folds nothing addressable.
func compressFoldIndexRegion(visible []provider.Message, plan visibleCompressionPlan) (region []provider.Message, start int, keptAt func(int) bool) {
	start = plan.firstFold
	if start < 0 || start >= len(visible) {
		return nil, 0, nil
	}
	end := start
	for i := len(visible) - 1; i >= start; i-- {
		if (i < len(plan.foldMask) && plan.foldMask[i]) || (i < len(plan.dropMask) && plan.dropMask[i]) {
			end = i + 1
			break
		}
	}
	if end <= start {
		return nil, 0, nil
	}
	region = visible[start:end]
	keptAt = func(j int) bool {
		i := start + j
		return !(i < len(plan.foldMask) && plan.foldMask[i]) && !(i < len(plan.dropMask) && plan.dropMask[i])
	}
	return region, start, keptAt
}

// foldIndexAttach is the shared product-side step for both fold paths: strip
// whatever index traces the model left in its digest, then append the
// host-written index. It never retries the summary — the appended index is
// authoritative, so a contaminated digest loses nothing but prose lines.
//
// region is the working-view slice being folded, regionOffset its position in
// view (head), keptAt the region positions the projection still shows, and
// fold the summarizer input (read for the prior index only; never modified).
func (a *Agent) foldIndexAttach(summary string, region []provider.Message, view []provider.Message, head int, keptAt func(int) bool, canonical []provider.Message, state CompactionState, fold []provider.Message) string {
	prose, _ := splitFoldIndex(summary)
	prose = stripIndexLines(prose)
	entries := buildFoldIndex(region, keptAt, canonicalOriginFor(state, canonical, view, head))
	return a.attachFoldIndex(prose, priorFoldIndexFrom(fold), entries)
}
