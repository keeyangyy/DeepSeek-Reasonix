// Command forkguard checks an upstream range against the fork's own
// customizations. It answers one question cheaply: which files that range
// touched belong to a topic we maintain, and which files it added are places
// where upstream could have implemented one of those topics itself.
//
// Those hits are what the sync pipeline hands to semantic review; the rest of
// the range is upstream's own work. The manifest it reads is
// tools/forkguard/customizations.json, kept beside this file.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// manifest is the fork's machine-readable customization list, one entry per
// change topic.
type manifest struct {
	Baseline string      `json:"baseline"`
	Topics   []forkTopic `json:"topics"`
}

// forkTopic is one topic's footprint: files we added, upstream files we mount
// onto, and the guard commands that catch it when a mount stops working.
type forkTopic struct {
	Topic  string   `json:"topic"`
	Branch string   `json:"branch"`
	Added  []string `json:"added"`
	Mounts []string `json:"mounts"`
	Guards []string `json:"guards"`
}

// change is one file an upstream range touched, with git's status letter.
type change struct {
	Status string
	Path   string
}

// hit is a change that lands on a topic the fork owns.
type hit struct {
	Topic  string `json:"topic"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Path   string `json:"path"`
}

// report is what the sync pipeline reads: the hits needing semantic review,
// upstream's own new files (where absorption shows up), and the guard commands
// of the topics that were hit.
type report struct {
	Baseline      string   `json:"baseline"`
	Range         string   `json:"range"`
	Changes       int      `json:"changes"`
	Hits          []hit    `json:"hits"`
	UpstreamAdded []string `json:"upstream_added"`
	Guards        []string `json:"guards"`
}

// parseNameStatus reads `git diff --name-status` output. A rename carries two
// paths; only the new one is ours to look at.
func parseNameStatus(out string) []change {
	changes := []change{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(fields) < 2 || fields[0] == "" {
			continue
		}
		changes = append(changes, change{Status: fields[0][:1], Path: fields[len(fields)-1]})
	}
	return changes
}

// changesIn runs git for one upstream range and returns what it touched.
func changesIn(dir, rng string) ([]change, error) {
	out, err := exec.Command("git", "-C", dir, "diff", "--name-status", rng).Output()
	if err != nil {
		return nil, fmt.Errorf("git diff %s: %w", rng, err)
	}
	return parseNameStatus(string(out)), nil
}

// match walks the changes once and sorts them into hits, upstream's own
// additions, and the guard commands carried by the topics that were hit.
func match(man manifest, changes []change) ([]hit, []string, []string) {
	mounted := map[string][]string{}
	added := map[string]string{}
	guards := map[string][]string{}
	for _, t := range man.Topics {
		for _, p := range t.Mounts {
			mounted[p] = append(mounted[p], t.Topic)
		}
		for _, p := range t.Added {
			added[p] = t.Topic
		}
		guards[t.Topic] = t.Guards
	}

	hits := []hit{}
	upstreamAdded := []string{}
	guardCmds := []string{}
	seen := map[string]bool{}
	for _, c := range changes {
		if c.Status == "A" {
			upstreamAdded = append(upstreamAdded, c.Path)
		}
		for _, topic := range mounted[c.Path] {
			hits = append(hits, hit{Topic: topic, Kind: "mount", Status: c.Status, Path: c.Path})
			guardCmds = addGuards(guards[topic], seen, guardCmds)
		}
		if topic, ok := added[c.Path]; ok {
			hits = append(hits, hit{Topic: topic, Kind: "added", Status: c.Status, Path: c.Path})
			guardCmds = addGuards(guards[topic], seen, guardCmds)
		}
	}
	sort.Strings(upstreamAdded)
	return hits, upstreamAdded, guardCmds
}

// addGuards appends the commands the report does not carry yet, so a topic hit
// on several files runs its guards once.
func addGuards(cmds []string, seen map[string]bool, out []string) []string {
	for _, c := range cmds {
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out
}

func main() {
	rng := flag.String("range", "", "upstream range to inspect, e.g. studio-v2.41.0..studio-v2.42.0")
	manifestPath := flag.String("manifest", "tools/forkguard/customizations.json", "customization manifest to read")
	repo := flag.String("repo", ".", "repository to run git in")
	flag.Parse()
	if *rng == "" {
		fmt.Fprintln(os.Stderr, "forkguard: -range is required")
		os.Exit(2)
	}

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "forkguard: read manifest: %v\n", err)
		os.Exit(1)
	}
	var man manifest
	if err := json.Unmarshal(raw, &man); err != nil {
		fmt.Fprintf(os.Stderr, "forkguard: parse manifest: %v\n", err)
		os.Exit(1)
	}

	changes, err := changesIn(*repo, *rng)
	if err != nil {
		fmt.Fprintf(os.Stderr, "forkguard: %v\n", err)
		os.Exit(1)
	}
	hits, upstreamAdded, guardCmds := match(man, changes)

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	err = enc.Encode(report{
		Baseline:      man.Baseline,
		Range:         *rng,
		Changes:       len(changes),
		Hits:          hits,
		UpstreamAdded: upstreamAdded,
		Guards:        guardCmds,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "forkguard: write report: %v\n", err)
		os.Exit(1)
	}
}
