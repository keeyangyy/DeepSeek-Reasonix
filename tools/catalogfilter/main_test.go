package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// entry builds one catalog entry with the given version and channel. Extra
// fields are added verbatim so tests can check that unread fields survive.
func entry(t *testing.T, version, channel string, extra map[string]string) json.RawMessage {
	t.Helper()
	fields := map[string]string{"version": version, "tag": "v" + version, "channel": channel}
	for k, v := range extra {
		fields[k] = v
	}
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal entry: %v", err)
	}
	return b
}

// versionsOf reads the version field of every entry, in order.
func versionsOf(t *testing.T, entries []json.RawMessage) []string {
	t.Helper()
	out := make([]string, 0, len(entries))
	for _, raw := range entries {
		var e struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatalf("unmarshal entry: %v", err)
		}
		out = append(out, e.Version)
	}
	return out
}

func TestTrimKeepsNewestPlusNewestStable(t *testing.T) {
	// Catalog order is newest first throughout.
	tests := []struct {
		name         string
		entries      []struct{ version, channel string }
		recent       int
		recentStable int
		want         []string
	}{
		{
			name: "head is all beta: stable quota reaches back past them",
			entries: []struct{ version, channel string }{
				{"1.38.59-beta.1", "beta"},
				{"1.38.58-beta.2", "beta"},
				{"1.38.58-beta.1", "beta"},
				{"1.38.57-beta.1", "beta"},
				{"1.38.56-beta.1", "beta"},
				{"1.38.55", "stable"},
				{"1.38.54", "stable"},
				{"1.38.53", "stable"},
				{"1.38.52", "stable"},
			},
			recent:       5,
			recentStable: 3,
			want: []string{
				"1.38.59-beta.1", "1.38.58-beta.2", "1.38.58-beta.1", "1.38.57-beta.1", "1.38.56-beta.1",
				"1.38.55", "1.38.54", "1.38.53",
			},
		},
		{
			name: "head is already all stable: stable rule adds nothing",
			entries: []struct{ version, channel string }{
				{"1.38.57", "stable"},
				{"1.38.56", "stable"},
				{"1.38.55", "stable"},
				{"1.38.54", "stable"},
				{"1.38.53", "stable"},
				{"1.38.52", "stable"},
			},
			recent:       5,
			recentStable: 3,
			want:         []string{"1.38.57", "1.38.56", "1.38.55", "1.38.54", "1.38.53"},
		},
		{
			name: "stable entries interleaved with betas",
			entries: []struct{ version, channel string }{
				{"1.38.57-beta.1", "beta"},
				{"1.38.56", "stable"},
				{"1.38.55-beta.1", "beta"},
				{"1.38.54", "stable"},
				{"1.38.53-beta.1", "beta"},
				{"1.38.52", "stable"},
			},
			recent:       3,
			recentStable: 2,
			want:         []string{"1.38.57-beta.1", "1.38.56", "1.38.55-beta.1", "1.38.54"},
		},
		{
			name: "fewer entries than either quota",
			entries: []struct{ version, channel string }{
				{"1.38.55-beta.1", "beta"},
				{"1.38.54", "stable"},
			},
			recent:       5,
			recentStable: 3,
			want:         []string{"1.38.55-beta.1", "1.38.54"},
		},
		{
			name:         "empty catalog",
			entries:      []struct{ version, channel string }{},
			recent:       5,
			recentStable: 3,
			want:         []string{},
		},
		{
			name: "recentStable zero matches the old keep-newest-only behaviour",
			entries: []struct{ version, channel string }{
				{"1.38.55-beta.1", "beta"},
				{"1.38.54", "stable"},
				{"1.38.53", "stable"},
			},
			recent:       1,
			recentStable: 0,
			want:         []string{"1.38.55-beta.1"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			entries := make([]json.RawMessage, 0, len(tc.entries))
			for _, e := range tc.entries {
				entries = append(entries, entry(t, e.version, e.channel, nil))
			}
			got, err := trim(entries, tc.recent, tc.recentStable)
			if err != nil {
				t.Fatalf("trim: %v", err)
			}
			if diff := versionsOf(t, got); !sameStrings(diff, tc.want) {
				t.Fatalf("kept %v, want %v", diff, tc.want)
			}
		})
	}
}

// An entry with no channel (or an unknown one) must never count toward the
// stable quota: that would let a pre-release claim a stable slot.
func TestTrimTreatsUnknownChannelAsNotStable(t *testing.T) {
	entries := []json.RawMessage{
		entry(t, "1.38.57-beta.1", "", nil),
		json.RawMessage(`{"version":"1.38.56"}`),
		entry(t, "1.38.55", "stable", nil),
	}
	got, err := trim(entries, 1, 1)
	if err != nil {
		t.Fatalf("trim: %v", err)
	}
	if diff := versionsOf(t, got); !sameStrings(diff, []string{"1.38.57-beta.1", "1.38.55"}) {
		t.Fatalf("kept %v, want [1.38.57-beta.1 1.38.55]", diff)
	}
}

// Fields the command does not read (notes, manifest, …) must survive the pass
// untouched, and document-level fields stay in place.
func TestMainPreservesUnreadFields(t *testing.T) {
	catalog := `{"schemaVersion":1,"updatedAt":"2026-10-16T00:00:00Z","versions":[
		{"version":"1.38.55-beta.1","tag":"v1.38.55-beta.1","channel":"beta","publishedAt":"2026-10-16T00:00:00Z","manifest":"https://example.test/v1.38.55-beta.1/latest.json","notes":"https://example.test/notes.md"},
		{"version":"1.38.54","tag":"v1.38.54","channel":"stable","publishedAt":"2026-10-15T00:00:00Z","manifest":"https://example.test/v1.38.54/latest.json"}
	]}`

	out, err := runFilter(t, catalog, 1, 1)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	var doc struct {
		SchemaVersion int               `json:"schemaVersion"`
		UpdatedAt     string            `json:"updatedAt"`
		Versions      []json.RawMessage `json:"versions"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if doc.SchemaVersion != 1 || doc.UpdatedAt == "" {
		t.Fatalf("document fields lost: %s", out)
	}
	if len(doc.Versions) != 2 {
		t.Fatalf("kept %d entries, want 2: %s", len(doc.Versions), out)
	}
	if !bytes.Contains(out, []byte(`"notes":"https://example.test/notes.md"`)) {
		t.Fatalf("entry field lost: %s", out)
	}
	if !bytes.Contains(out, []byte(`"manifest":"https://example.test/v1.38.54/latest.json"`)) {
		t.Fatalf("entry field lost: %s", out)
	}
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

// runFilter pipes catalog through the command's document handling and trim
// pass, reproducing main without spawning a process.
func runFilter(t *testing.T, catalog string, recent, recentStable int) ([]byte, error) {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.NewDecoder(strings.NewReader(catalog)).Decode(&doc); err != nil {
		return nil, err
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(doc["versions"], &entries); err != nil {
		return nil, err
	}
	kept, err := trim(entries, recent, recentStable)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return nil, err
	}
	doc["versions"] = encoded
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
