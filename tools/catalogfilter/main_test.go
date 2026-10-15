package main

import (
	"encoding/json"
	"testing"
)

// entry builds one catalog entry the way update-versions-index.sh writes it.
func entry(version string) json.RawMessage {
	raw, err := json.Marshal(map[string]string{
		"version":     version,
		"tag":         "v" + version,
		"channel":     "studio",
		"publishedAt": "2026-10-11T00:00:00Z",
		"manifest":    "https://example.test/" + version + "/latest.json",
	})
	if err != nil {
		panic(err)
	}
	return raw
}

// keptVersions names the entries trim decided to keep, in order.
func keptVersions(t *testing.T, entries []json.RawMessage) []string {
	t.Helper()
	out := make([]string, len(entries))
	for i, raw := range entries {
		v, err := versionOf(raw)
		if err != nil {
			t.Fatalf("entry %d: %v", i, err)
		}
		out[i] = v
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The union the filter exists for: the newest base was iterated four times, so
// the newest five reach back into it, while the older bases keep their own
// newest build even though those sit outside the newest five.
func TestTrimKeepsNewestAndOnePerBase(t *testing.T) {
	in := []json.RawMessage{
		entry("2.35.0-mine.4"),
		entry("2.35.0-mine.3"),
		entry("2.35.0-mine.2"),
		entry("2.35.0-mine.1"),
		entry("2.34.0-mine.2"),
		entry("2.34.0-mine.1"),
		entry("2.33.0-mine.1"),
		entry("2.32.0-mine.3"),
		entry("2.32.0-mine.2"),
		entry("2.31.0-mine.1"),
	}
	got, err := trim(in, 5)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"2.35.0-mine.4", "2.35.0-mine.3", "2.35.0-mine.2", "2.35.0-mine.1",
		"2.34.0-mine.2",
		"2.33.0-mine.1",
		"2.32.0-mine.3",
		"2.31.0-mine.1",
	}
	if !sameStrings(keptVersions(t, got), want) {
		t.Fatalf("trim kept %v, want %v", keptVersions(t, got), want)
	}
}

// An entry dropped by both rules is exactly the older iteration of an older
// base, which is what the size cap is for.
func TestTrimDropsOlderIterationsOfOlderBases(t *testing.T) {
	in := []json.RawMessage{
		entry("2.35.0-mine.1"),
		entry("2.34.0-mine.1"),
		entry("2.33.0-mine.3"),
		entry("2.33.0-mine.2"),
		entry("2.33.0-mine.1"),
	}
	got, err := trim(in, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"2.35.0-mine.1", "2.34.0-mine.1", "2.33.0-mine.3"}
	if !sameStrings(keptVersions(t, got), want) {
		t.Fatalf("trim kept %v, want %v", keptVersions(t, got), want)
	}
}

// A catalog the fork has only just started is one entry wide.
func TestTrimKeepsASingleEntry(t *testing.T) {
	got, err := trim([]json.RawMessage{entry("2.35.0-mine.1")}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !sameStrings(keptVersions(t, got), []string{"2.35.0-mine.1"}) {
		t.Fatalf("trim kept %v", keptVersions(t, got))
	}
}

func TestTrimKeepsAnEmptyCatalogEmpty(t *testing.T) {
	got, err := trim(nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("trim kept %d entries from nothing", len(got))
	}
}

// A version with no fork increment shares its base with the fork builds made
// from it, so one entry per base covers both — and the newest of that group
// wins, which CompareVersions already orders as "2.35.0" over "2.35.0-mine.1".
func TestTrimGroupsAPlainVersionWithItsForkBuilds(t *testing.T) {
	in := []json.RawMessage{
		entry("2.35.0"),
		entry("2.35.0-mine.1"),
		entry("2.34.0-mine.1"),
	}
	got, err := trim(in, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"2.35.0", "2.34.0-mine.1"}
	if !sameStrings(keptVersions(t, got), want) {
		t.Fatalf("trim kept %v, want %v", keptVersions(t, got), want)
	}
}

// Index-shaped input, so a catalog without versions fails loudly instead of
// being written back as an empty list.
func TestTrimRefusesAnEntryWithoutAVersion(t *testing.T) {
	if _, err := trim([]json.RawMessage{json.RawMessage(`{"tag":"v2.35.0-mine.1"}`)}, 5); err == nil {
		t.Fatal("trim accepted an entry with no version")
	}
}
