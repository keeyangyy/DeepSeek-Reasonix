// Command catalogfilter trims this line's release catalog to the entries the
// update panel lists: the newest few releases whatever their channel, plus the
// newest few stable releases on top of that.
//
// Both halves matter: a run of pre-releases at the head of the catalog must not
// push the newest stable release off the panel. It reads a catalog on stdin
// (newest first, as update-versions-index.sh writes it) and writes it back with
// entries removed, preserving order and every field it does not read.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

// stableChannel is the channel value a released (non-pre-release) version
// carries. Every other value — "beta", a future channel, or a missing field —
// is treated as "not stable", so an unknown entry never counts toward the
// stable quota.
const stableChannel = "stable"

// channelOf reads the channel field out of one entry, leaving the rest of it
// untouched.
func channelOf(raw json.RawMessage) (string, error) {
	var e struct {
		Channel string `json:"channel"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", err
	}
	return e.Channel, nil
}

// trim keeps the newest `recent` entries plus the newest `recentStable` entries
// whose channel is stable, preserving the order it was given. Entries arrive
// newest first, so both "newest" rules select from the head.
//
// The two sets overlap by design: when the head of the catalog is already all
// stable, the stable rule adds nothing and the result is just the newest
// `recent` entries.
func trim(entries []json.RawMessage, recent, recentStable int) ([]json.RawMessage, error) {
	keep := make(map[int]bool, len(entries))
	for i := 0; i < len(entries) && i < recent; i++ {
		keep[i] = true
	}

	stableKept := 0
	for i, raw := range entries {
		if stableKept >= recentStable {
			break
		}
		channel, err := channelOf(raw)
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		if channel == stableChannel {
			keep[i] = true
			stableKept++
		}
	}

	out := make([]json.RawMessage, 0, len(keep))
	for i, raw := range entries {
		if keep[i] {
			out = append(out, raw)
		}
	}
	return out, nil
}

func main() {
	recent := flag.Int("recent", 5, "how many newest entries to keep whatever their channel")
	recentStable := flag.Int("recent-stable", 3, "how many newest stable entries to keep on top of that")
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

	kept, err := trim(entries, *recent, *recentStable)
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
