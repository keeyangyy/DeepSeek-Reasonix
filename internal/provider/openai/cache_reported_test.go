package openai

import (
	"encoding/json"
	"testing"
)

// normaliseUsage must distinguish "provider said zero" from "provider said
// nothing". Gateways such as AxonHub fronting ModelScope return only the three
// base counters; treating that as "every prompt missed" is what dragged the
// cache-rate display to 0%.
func TestNormaliseUsageMarksWhetherCacheWasReported(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		wantHit  int
		wantMiss int
		wantRep  bool
	}{
		{
			name:    "gateway without cache fields (ModelScope via AxonHub)",
			raw:     `{"prompt_tokens":124479,"completion_tokens":94,"total_tokens":124573}`,
			wantRep: false,
		},
		{
			name:    "openai-style details with a real hit",
			raw:     `{"prompt_tokens":4036,"completion_tokens":8,"total_tokens":4044,"prompt_tokens_details":{"cached_tokens":3968}}`,
			wantHit: 3968, wantMiss: 68, wantRep: true,
		},
		{
			// Measured: deepseek-flash reports the detail object with a zero
			// value on a cold call. That is a reported zero, not silence.
			name:    "openai-style details reporting zero",
			raw:     `{"prompt_tokens":45,"completion_tokens":96,"total_tokens":141,"prompt_tokens_details":{"cached_tokens":0}}`,
			wantRep: true,
		},
		{
			name:    "deepseek top-level cache fields",
			raw:     `{"prompt_tokens":1000,"completion_tokens":10,"total_tokens":1010,"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100}`,
			wantHit: 900, wantMiss: 100, wantRep: true,
		},
		{
			name:    "anthropic-style cache read",
			raw:     `{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":400}`,
			wantHit: 400, wantMiss: 10, wantRep: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var raw wireUsage
			if err := json.Unmarshal([]byte(c.raw), &raw); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			u := normaliseUsage(&raw)
			if u.CacheHitTokens != c.wantHit || u.CacheMissTokens != c.wantMiss {
				t.Fatalf("hit/miss = %d/%d, want %d/%d",
					u.CacheHitTokens, u.CacheMissTokens, c.wantHit, c.wantMiss)
			}
			if u.CacheReported != c.wantRep {
				t.Fatalf("CacheReported = %v, want %v", u.CacheReported, c.wantRep)
			}
		})
	}
}
