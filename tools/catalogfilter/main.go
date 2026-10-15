// Command catalogfilter trims a Studio release catalog to the entries a
// rollback needs: the newest few entries, plus one per upstream base version.
// Both are needed — a fork release is cut from an upstream base and then
// iterated on it (v2.32.0-mine.1, -mine.2, -mine.3), so the newest N reach
// back into the current series while one-per-base keeps every base reachable.
// It reads a catalog on stdin (ordered newest first, as
// update-versions-index.sh writes it) and writes it with entries removed,
// preserving order and every field it does not read.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
)

// mineSuffix is the fork's own increment on an upstream base: v2.32.0-mine.3.
// What is left after stripping it is the base, which is what "one entry per
// base" groups by.
var mineSuffix = regexp.MustCompile(`-mine\.[0-9]+$`)

// baseOf is the upstream release a fork version derives from.
func baseOf(version string) string {
	return mineSuffix.ReplaceAllString(version, "")
}

// versionOf reads the version field out of one entry, leaving the rest of it
// untouched.
func versionOf(raw json.RawMessage) (string, error) {
	var e struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", err
	}
	if e.Version == "" {
		return "", fmt.Errorf("entry carries no version")
	}
	return e.Version, nil
}

// trim keeps the first recent entries and the first entry of every base
// version, preserving the order it was given. Entries arrive newest first, so
// both "first" rules select the newest of what they cover.
func trim(entries []json.RawMessage, recent int) ([]json.RawMessage, error) {
	versions := make([]string, len(entries))
	for i, raw := range entries {
		v, err := versionOf(raw)
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		versions[i] = v
	}

	keep := make(map[string]bool, len(entries))
	for i, v := range versions {
		if i < recent {
			keep[v] = true
		}
	}
	seen := make(map[string]bool, len(entries))
	for _, v := range versions {
		if base := baseOf(v); !seen[base] {
			seen[base] = true
			keep[v] = true
		}
	}

	out := make([]json.RawMessage, 0, len(keep))
	for i, v := range versions {
		if keep[v] {
			out = append(out, entries[i])
		}
	}
	return out, nil
}

func main() {
	recent := flag.Int("recent", 5, "how many newest entries to keep whatever their base version")
	flag.Parse()

	var doc map[string]json.RawMessage
	if err := json.NewDecoder(os.Stdin).Decode(&doc); err != nil {
		fmt.Fprintf(os.Stderr, "catalogfilter: read catalog: %v\n", err)
		os.Exit(1)
	}
	raw, ok := doc["versions"]
	if !ok {
		fmt.Fprintln(os.Stderr, "catalogfilter: catalog has no versions field")
		os.Exit(1)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		fmt.Fprintf(os.Stderr, "catalogfilter: read versions: %v\n", err)
		os.Exit(1)
	}

	kept, err := trim(entries, *recent)
	if err != nil {
		fmt.Fprintf(os.Stderr, "catalogfilter: %v\n", err)
		os.Exit(1)
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		fmt.Fprintf(os.Stderr, "catalogfilter: encode versions: %v\n", err)
		os.Exit(1)
	}
	doc["versions"] = encoded

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		fmt.Fprintf(os.Stderr, "catalogfilter: write catalog: %v\n", err)
		os.Exit(1)
	}
}
