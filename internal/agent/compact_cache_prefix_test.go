package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"reasonix/internal/sessioncontext"
	"reasonix/internal/tool"
)

// prefixReplayRecorder captures every provider request so a test can prove the
// compaction request replays the ordinary request's prefix byte-for-byte.
type prefixReplayRecorder struct {
	mu       sync.Mutex
	ordinary [][]json.RawMessage
	summary  [][]json.RawMessage
	t        *testing.T
}

func (r *prefixReplayRecorder) handler(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	msgs := decodeMessages(body)
	r.mu.Lock()
	if isSummarizeRequest(body) {
		r.summary = append(r.summary, msgs)
	} else {
		r.ordinary = append(r.ordinary, msgs)
	}
	r.mu.Unlock()
	writeSSE(w, r.t,
		streamChunk(deltaText("done")),
		finishChunk("stop"),
		usageChunk(100, 10, 0, 100),
	)
}

func (r *prefixReplayRecorder) lastSummary() []json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.summary) == 0 {
		return nil
	}
	return r.summary[len(r.summary)-1]
}

func (r *prefixReplayRecorder) lastOrdinary() []json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.ordinary) == 0 {
		return nil
	}
	return r.ordinary[len(r.ordinary)-1]
}

func isSessionContextRaw(raw json.RawMessage) bool {
	var parsed struct {
		Content string `json:"content"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return strings.HasPrefix(strings.TrimSpace(parsed.Content), "<session-context")
}

// TestCompactionReplaysCacheablePrefixWithSessionContext pins the prompt-cache
// contract: the compaction request must replay the ordinary request's prefix
// byte-for-byte and only append the compaction instruction. Session-context
// snapshots are part of that prefix, so stripping them from the summarizer
// input silently forfeits cache reuse (measured 14% before the fix, 100% after).
func TestCompactionReplaysCacheablePrefixWithSessionContext(t *testing.T) {
	rec := &prefixReplayRecorder{t: t}
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	defer srv.Close()

	a, _ := newAgent(t, srv.URL, tool.NewRegistry(), 30000, 2)
	ctx := WithTurnContextBundle(context.Background(), TurnContextBundle{
		Executor: sessioncontext.Build(sessioncontext.Sections{
			Environment:      "probe env",
			Workspace:        `Current workspace: "/probe"`,
			SkillsCatalog:    "probe skills catalog",
			BackgroundMemory: "probe background memory index",
		}),
	})
	for i := range 8 {
		input := strings.Repeat("probe request text for fold planning. ", 400) + fmt.Sprint(i)
		if err := a.Run(ctx, input); err != nil {
			t.Fatalf("Run %d: %v", i, err)
		}
	}

	before := rec.lastOrdinary()
	if err := a.CompactNow(context.Background(), ""); err != nil {
		t.Fatalf("CompactNow: %v", err)
	}
	summary := rec.lastSummary()
	if before == nil || summary == nil {
		t.Fatalf("missing requests: ordinary=%d summary=%d", len(rec.ordinary), len(rec.summary))
	}

	// The summarizer request is the replayed prefix plus one trailing
	// instruction, so the prefix must match the ordinary request exactly.
	replayed := summary[:len(summary)-1]
	if len(replayed) != len(before) {
		t.Fatalf("replayed prefix has %d messages, ordinary request has %d", len(replayed), len(before))
	}
	if common := commonPrefixMsgs(before, replayed); common != len(replayed) {
		t.Fatalf("compaction replayed only %d/%d messages of the ordinary prefix: "+
			"the KV cache cannot be reused from message %d", common, len(replayed), common)
	}
	snapshots := 0
	for _, m := range replayed {
		if isSessionContextRaw(m) {
			snapshots++
		}
	}
	if snapshots == 0 {
		t.Fatal("replayed prefix carried no session-context snapshot; the fixture no longer covers the regression")
	}
}
