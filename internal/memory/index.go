// The provider-visible memory index: scope-qualified references for every
// active fact, override annotations for shadowed global guidance.
package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	fileutil "reasonix/internal/fileutil"
	fileencoding "reasonix/internal/fileutil/encoding"
)

// Index returns the provider-visible index that loads into the cached
// prefix: every active fact from both scopes with a scope-qualified
// reference, shadowed global facts annotated rather than hidden — the index
// agrees with the project-over-global rule recall enforces (#7995). The
// per-directory MEMORY.md files keep their unqualified format.
func (s Store) Index() string {
	memories := s.ListAll()
	if len(memories) == 0 {
		return ""
	}
	shadowed := map[string]string{} // global fact ID -> winning project reference
	for _, o := range FindOverrides(memories) {
		shadowed[o.Global.ID] = providerMemoryReference(o.Project)
	}
	sort.SliceStable(memories, func(i, j int) bool {
		if memories[i].Name != memories[j].Name {
			return memories[i].Name < memories[j].Name
		}
		return NormalizeFactScope(string(memories[i].Scope)) == FactScopeProject
	})
	var b strings.Builder
	seen := map[string]bool{} // collapse legacy migration duplicates (same qualified ref)
	for _, memory := range memories {
		if ref := providerMemoryReference(memory); seen[ref] {
			continue
		} else {
			seen[ref] = true
		}
		b.WriteString(renderQualifiedIndexLine(memory))
		if winner, ok := shadowed[memory.ID]; ok &&
			NormalizeFactScope(string(memory.Scope)) == FactScopeGlobal {
			b.WriteString(" (overridden by " + winner + ")")
		}
		b.WriteString("\n")
	}
	return b.String()
}

// renderQualifiedIndexLine is the provider-index variant of renderIndexLine:
// the link is the scope-qualified reference every memory tool accepts, so a
// name collision across scopes can never be misread.
func renderQualifiedIndexLine(m Memory) string {
	marker := ""
	if ResolveActivation(m) == ActivationPinned {
		marker = " pinned"
	}
	ref := providerMemoryReference(m)
	return fmt.Sprintf("- [%s](%s) — [%s/%s%s] %s",
		displayTitle(m.Title, m.Name), ref,
		NormalizeFactScope(string(m.Scope)), NormalizeType(string(m.Type)), marker, oneLine(m.Description))
}

// indexLineRe matches a managed index line so reindex/Delete can target the line
// for one memory by its filename without disturbing the rest of a hand-edited
// MEMORY.md.
var indexLineRe = regexp.MustCompile(`(?m)^\s*-\s\[.+?\]\(([^)]+)\.md\)\s*—\s.*$`)

// readIndexIn treats a missing index as empty, but does not hide other read errors.
func readIndexIn(dir string) ([]byte, error) {
	existing, err := fileencoding.ReadFileUTF8(filepath.Join(dir, indexFile))
	if os.IsNotExist(err) {
		return nil, nil
	}
	return existing, err
}

// indexLinesExceptIn returns the managed MEMORY.md lines keyed by filename stem,
// dropping the entry for name and reporting whether it was present.
func indexLinesExceptIn(dir, name string) (map[string]string, bool, error) {
	existing, err := readIndexIn(dir)
	if err != nil {
		return nil, false, err
	}
	keep := map[string]string{}
	contains := false
	for line := range strings.SplitSeq(string(existing), "\n") {
		if mt := indexLineRe.FindStringSubmatch(line); mt != nil {
			if mt[1] == name {
				contains = true
			} else {
				keep[mt[1]] = strings.TrimRight(line, "\r")
			}
		}
	}
	return keep, contains, nil
}

// flushIndexIn rewrites MEMORY.md in the given directory from the managed lines,
// preserving hand-written content. Managed lines are updated or removed, and
// new managed entries are appended in sorted order.
func flushIndexIn(dir string, lines map[string]string) error {
	path := filepath.Join(dir, indexFile)
	existing, err := readIndexIn(dir)
	if err != nil {
		return err
	}
	processed := map[string]bool{}
	var preserved strings.Builder
	preservedEmpty := true
	for line := range strings.SplitSeq(string(existing), "\n") {
		trimmed := strings.TrimRight(line, "\r")
		if mt := indexLineRe.FindStringSubmatch(trimmed); mt != nil {
			name := mt[1]
			if fresh, ok := lines[name]; ok {
				preserved.WriteString(fresh)
				preserved.WriteString("\n")
				processed[name] = true
				preservedEmpty = false
			}
			continue
		}
		preserved.WriteString(trimmed)
		preserved.WriteString("\n")
		if strings.TrimSpace(trimmed) != "" {
			preservedEmpty = false
		}
	}

	names := make([]string, 0, len(lines))
	for n := range lines {
		if !processed[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)

	var b strings.Builder
	if preservedEmpty && len(names) > 0 {
		b.WriteString("# Memory\n\n")
	} else {
		b.WriteString(preserved.String())
	}
	for _, n := range names {
		b.WriteString(lines[n])
		b.WriteString("\n")
	}
	result := strings.TrimRight(b.String(), "\n")
	if result != "" {
		result += "\n"
	}
	// The index is derived state, but a torn write would still hide facts
	// from the next real turn's session-context until the next reindex.
	return fileutil.AtomicWriteFile(path, []byte(result), 0o644)
}

// reindexIn rewrites the MEMORY.md line for name in the given directory,
// preserving every other managed line.
func reindexIn(dir, name string, m Memory) error {
	lines, _, err := indexLinesExceptIn(dir, name)
	if err != nil {
		return err
	}
	lines[name] = renderIndexLine(name, m)
	return flushIndexIn(dir, lines)
}

func renderIndexLine(name string, m Memory) string {
	marker := ""
	if ResolveActivation(m) == ActivationPinned {
		marker = " pinned" // the body already rides session-context; no need to read it
	}
	return fmt.Sprintf("- [%s](%s.md) — [%s/%s%s] %s",
		displayTitle(m.Title, name), name,
		NormalizeFactScope(string(m.Scope)), NormalizeType(string(m.Type)), marker, oneLine(m.Description))
}
