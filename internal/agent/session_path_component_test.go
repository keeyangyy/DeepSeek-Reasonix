package agent

import (
	"path/filepath"
	"strings"
	"testing"
)

// sessionRel returns the single path component NewSessionPath produced for the
// model label, failing if the label managed to escape the session directory or
// yielded a component that is not portable.
func sessionRel(t *testing.T, dir, model string) string {
	t.Helper()
	path := NewSessionPath(dir, model)
	rel, err := filepath.Rel(dir, path)
	if err != nil || rel != filepath.Base(path) || !filepath.IsLocal(rel) {
		t.Fatalf("model escaped session directory: %q, %v", path, err)
	}
	if strings.ContainsAny(rel, "<>:\"/\\|?*\x00\n\r") {
		t.Fatalf("nonportable session filename: %q", rel)
	}
	return rel
}

func TestNewSessionPathKeepsUntrustedModelInOnePortableComponent(t *testing.T) {
	for _, model := range []string{"../../outside", `..\..\outside`, "..", "vendor/model:tag", "model\x00suffix", "model\nline", "模型-v1.2"} {
		t.Run(model, func(t *testing.T) {
			rel := sessionRel(t, t.TempDir(), model)
			if strings.ContainsAny(model, "\x00\n") && !strings.HasSuffix(rel, "-session.jsonl") {
				t.Fatalf("invalid label did not use the safe fallback: %q", rel)
			}
		})
	}
}

func TestNewSessionPathEmptyModelUsesSafeFallback(t *testing.T) {
	rel := sessionRel(t, t.TempDir(), "")
	if !strings.HasSuffix(rel, "-session.jsonl") {
		t.Fatalf("empty model should produce a plain session name, got %q", rel)
	}
}

func TestNewSessionPathOverlongModelFallsBack(t *testing.T) {
	rel := sessionRel(t, t.TempDir(), strings.Repeat("m", 1000))
	if len(rel) > maxSessionFileComponentBytes {
		t.Fatalf("session filename component too long: %d bytes", len(rel))
	}
	if !strings.HasSuffix(rel, "-session.jsonl") {
		t.Fatalf("overlong model should fall back to the generic session name, got %q", rel)
	}
}

func TestNewSessionPathLeavesNormalModelNameAlone(t *testing.T) {
	rel := sessionRel(t, t.TempDir(), "deepseek-reasoner")
	if want := "-deepseek-reasoner.jsonl"; !strings.HasSuffix(rel, want) {
		t.Fatalf("normal model name was rewritten unexpectedly: %q, want suffix %q", rel, want)
	}
}
