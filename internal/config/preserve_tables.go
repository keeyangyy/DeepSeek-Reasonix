package config

import (
	"sort"
	"strconv"
	"strings"
)

// preserve_tables.go — keeping array-of-tables elements whole. A [[providers]]
// or [[plugins]] element belongs to whoever wrote it, so replacing it wholesale
// would drop the keys this build does not model. Elements are matched by name.

// arrayElement is one element of an array of tables: the region it owns (its
// header, its own keys, and any sub-tables the file nests under it) and the name
// that identifies it.
type arrayElement struct {
	name  string
	start int
	end   int
	text  string
}

// arrayElements splits the elements of [[section]] out of body in file order.
// It reports false when any element is unnamed or two share a name: those cannot
// be matched across a save, and the caller must not invent a match.
func arrayElements(body, section string) ([]arrayElement, bool) {
	spans := tomlLineSpans(body)
	structural := tomlStructuralLineMask(spans)
	var starts []int
	for i, span := range spans {
		if !structural[i] {
			continue
		}
		name, isArray, ok := tomlEditSectionHeader(span.text)
		if ok && isArray && name == section {
			starts = append(starts, i)
		}
	}
	if len(starts) == 0 {
		return nil, true
	}
	elems := make([]arrayElement, 0, len(starts))
	for n, idx := range starts {
		end := len(body)
		if n+1 < len(starts) {
			// Everything up to the next element's header belongs to this one,
			// sub-tables included.
			end = spans[starts[n+1]].start
		} else {
			for j := idx + 1; j < len(spans); j++ {
				if !structural[j] {
					continue
				}
				name, _, ok := tomlEditSectionHeader(spans[j].text)
				if !ok {
					continue
				}
				if name == section || strings.HasPrefix(name, section+".") {
					continue
				}
				end = spans[j].start
				break
			}
		}
		elem := arrayElement{start: spans[idx].start, end: end}
		elem.text = body[elem.start:elem.end]
		elems = append(elems, elem)
	}
	seen := make(map[string]bool, len(elems))
	for i := range elems {
		name, ok := arrayElementName(elems[i].text)
		if !ok || seen[name] {
			return nil, false
		}
		seen[name] = true
		elems[i].name = name
	}
	return elems, true
}

// arrayElementName reads the element's identity from its own identity key.
// Providers and plugins carry `name`; bot connections carry `id`. Keys below
// the element's first sub-table header belong to that sub-table, not to the
// element, so they are not identities.
func arrayElementName(block string) (string, bool) {
	for _, key := range []string{"name", "id"} {
		if value, ok := arrayElementKeyValue(block, key); ok {
			return value, true
		}
	}
	return "", false
}

func arrayElementKeyValue(block, want string) (string, bool) {
	spans := tomlLineSpans(block)
	structural := tomlStructuralLineMask(spans)
	for i, span := range spans {
		if !structural[i] {
			continue
		}
		if _, _, isHeader := tomlEditSectionHeader(span.text); isHeader {
			if i == 0 {
				continue // the element's own [[section]] header
			}
			break
		}
		key, value, ok := tomlKeyValue(span.text)
		if !ok || key != want {
			continue
		}
		return tomlStringValue(value)
	}
	return "", false
}

// tomlStringValue decodes a single-line TOML string literal, with or without an
// inline comment. Anything else is not an identity this code will guess at.
func tomlStringValue(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if before, _, ok := strings.Cut(value, "#"); ok {
		value = strings.TrimSpace(before)
	}
	if len(value) < 2 {
		return "", false
	}
	switch value[0] {
	case '"':
		if value[len(value)-1] != '"' {
			return "", false
		}
		decoded, err := strconv.Unquote(value)
		if err != nil {
			return "", false
		}
		return decoded, true
	case '\'':
		if value[len(value)-1] != '\'' {
			return "", false
		}
		return value[1 : len(value)-1], true
	default:
		return "", false
	}
}

// elementOwnKeyLines lists the element's own key assignments (not the keys of
// the sub-tables it nests), keyed by name, each with its verbatim text.
func elementOwnKeyLines(block string) map[string]string {
	out := map[string]string{}
	spans := tomlLineSpans(block)
	structural := tomlStructuralLineMask(spans)
	for i, span := range spans {
		if !structural[i] {
			continue
		}
		if _, _, isHeader := tomlEditSectionHeader(span.text); isHeader {
			if i == 0 {
				continue // the element's own header
			}
			break // sub-tables start here
		}
		key, _, ok := tomlKeyValue(span.text)
		if !ok {
			continue
		}
		end := tomlValueEndSpan(spans, i)
		var b strings.Builder
		for j := i; j <= end; j++ {
			b.WriteString(spans[j].text)
		}
		out[key] = b.String()
	}
	return out
}

// carryArrayElementFields appends to next, for each element of the array, the
// key lines the current file keeps for the element of the same name but the
// render does not write. It reports false when the two sides cannot be matched
// element by element, leaving the caller to refuse the save rather than write a
// lossy one.
func carryArrayElementFields(body, next, section string) (string, bool) {
	oldElems, ok := arrayElements(body, section)
	if !ok {
		return "", false
	}
	if len(oldElems) == 0 {
		return next, true
	}
	newElems, ok := arrayElements(next, section)
	if !ok || len(newElems) == 0 {
		return "", false
	}
	blocks := make([]string, 0, len(newElems))
	for _, elem := range newElems {
		block := strings.TrimRight(elem.text, "\n")
		if old, found := findArrayElement(oldElems, elem.name); found {
			block = appendMissingElementKeys(block, old.text)
		}
		blocks = append(blocks, block)
	}
	rebuilt := strings.Join(blocks, "\n\n") + "\n\n"
	return next[:newElems[0].start] + rebuilt + next[newElems[len(newElems)-1].end:], true
}

func findArrayElement(elems []arrayElement, name string) (arrayElement, bool) {
	for _, elem := range elems {
		if elem.name == name {
			return elem, true
		}
	}
	return arrayElement{}, false
}

// appendMissingElementKeys writes into block, just before its first sub-table,
// every own key the old element had and block does not.
func appendMissingElementKeys(block, oldBlock string) string {
	have := elementOwnKeyLines(block)
	missing := elementOwnKeyLines(oldBlock)
	names := make([]string, 0, len(missing))
	for name := range missing {
		if _, exists := have[name]; exists {
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return block
	}
	sort.Strings(names)
	var carried strings.Builder
	for _, name := range names {
		carried.WriteString(missing[name])
	}
	return insertElementKeys(block, carried.String())
}

// insertElementKeys puts carried keys after the element's last own key and
// before its first sub-table header, matching how the renderer orders them.
func insertElementKeys(block, keys string) string {
	spans := tomlLineSpans(block)
	structural := tomlStructuralLineMask(spans)
	insertAt := -1
	for i, span := range spans {
		if !structural[i] {
			continue
		}
		if _, _, isHeader := tomlEditSectionHeader(span.text); isHeader {
			if i == 0 {
				continue // the element's own header
			}
			insertAt = span.start // first sub-table: carried keys go above it
			break
		}
		if _, _, ok := tomlKeyValue(span.text); ok {
			insertAt = spans[tomlValueEndSpan(spans, i)].end
		}
	}
	if insertAt < 0 {
		if len(spans) == 0 {
			return block
		}
		insertAt = spans[0].end // nothing but the header: write after it
	}
	// The element text is trimmed of its trailing newlines, so the last line
	// may end at len(block) with no line break. Start the carried keys on a
	// line of their own instead of gluing them to that last value.
	prefix := block[:insertAt]
	if prefix != "" && !strings.HasSuffix(prefix, "\n") {
		keys = "\n" + keys
	}
	if keys != "" && !strings.HasSuffix(keys, "\n") {
		keys += "\n"
	}
	return prefix + keys + block[insertAt:]
}
