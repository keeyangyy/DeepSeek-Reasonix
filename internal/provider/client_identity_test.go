package provider

import (
	"net/http"
	"testing"
)

func TestApplyClientIdentityUsesBuildVersion(t *testing.T) {
	SetClientVersion("9.8.7")
	t.Cleanup(func() { SetClientVersion("") })

	req, _ := http.NewRequest(http.MethodPost, "https://api.deepseek.com/chat/completions", nil)
	ApplyClientIdentity(req)
	if got := req.Header.Get("User-Agent"); got != "Reasonix/9.8.7" {
		t.Fatalf("User-Agent = %q, want Reasonix/9.8.7", got)
	}
}

func TestApplyClientIdentityKeepsExplicitUserAgent(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPost, "https://api.deepseek.com/chat/completions", nil)
	req.Header.Set("User-Agent", "claude-code/0.1.0")
	ApplyClientIdentity(req)
	if got := req.Header.Get("User-Agent"); got != "claude-code/0.1.0" {
		t.Fatalf("explicit User-Agent was overwritten: %q", got)
	}
}

// TestApplyClientHeadersPrefersOpenCodeContract pins the precedence: the
// opencode endpoint keeps its bare identity, every other endpoint gets the
// versioned one.
func TestApplyClientHeadersPrefersOpenCodeContract(t *testing.T) {
	SetClientVersion("9.8.7")
	t.Cleanup(func() { SetClientVersion("") })

	opencode, _ := http.NewRequest(http.MethodPost, "https://opencode.ai/zen/go/v1/responses", nil)
	ApplyClientHeaders(opencode, "https://opencode.ai/zen/go/v1", NewClientIdentityHeaders())
	if got := opencode.Header.Get("User-Agent"); got != "Reasonix" {
		t.Fatalf("opencode User-Agent = %q, want the bare Reasonix identity", got)
	}

	other, _ := http.NewRequest(http.MethodPost, "https://api.deepseek.com/chat/completions", nil)
	ApplyClientHeaders(other, "https://api.deepseek.com", NewClientIdentityHeaders())
	if got := other.Header.Get("User-Agent"); got != "Reasonix/9.8.7" {
		t.Fatalf("generic User-Agent = %q, want Reasonix/9.8.7", got)
	}
}
