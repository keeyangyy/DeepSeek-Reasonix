package billing

import (
	"testing"
	"time"
)

func bucketBySource(t *testing.T, l *Ledger, source string) LedgerEntry {
	t.Helper()
	for _, ent := range l.Entries {
		if ent.UsageSource == source {
			return ent
		}
	}
	t.Fatalf("bucket %q not found in %d entries", source, len(l.Entries))
	return LedgerEntry{}
}

func reportedTestQuote(source, model string) CostQuote {
	return CostQuote{
		Original:     Money{Amount: "1", Currency: "CNY"},
		Valuations:   map[string]Valuation{"CNY": {Money: Money{Amount: "1", Currency: "CNY"}, Basis: BasisIdentity}},
		CostComplete: true, DisplayComplete: true, Complete: true,
		DisplayStatus: DisplayStatusMatched, ModelRef: model, UsageSource: source,
		PricingFingerprint: "fp-" + source,
	}
}

// Billing must keep counting unreported calls as fully uncached input, while
// cache-rate readers get a separate pair covering only calls whose provider
// actually returned cache counters. Collapsing the two is what made a gateway
// without cache fields look like a 0% hit rate.
func TestLedgerSeparatesReportedCacheFromBillingFallback(t *testing.T) {
	l := NewLedger()
	l.Add(reportedTestQuote("reported", "axon/deepseek-flash"), UsageTokens{
		PromptTokens: 1000, CompletionTokens: 10,
		CacheHitTokens: 900, CacheMissTokens: 100, CacheReported: true,
	}, time.Time{})
	l.Add(reportedTestQuote("silent", "axon/deepseek-flash-ms"), UsageTokens{
		PromptTokens: 500, CompletionTokens: 10,
	}, time.Time{})

	reported := bucketBySource(t, l, "reported")
	silent := bucketBySource(t, l, "silent")

	if reported.ReportedCacheHitTokens != 900 || reported.ReportedCacheMissTokens != 100 {
		t.Fatalf("reported pair = %d/%d, want 900/100",
			reported.ReportedCacheHitTokens, reported.ReportedCacheMissTokens)
	}
	if silent.ReportedCacheHitTokens != 0 || silent.ReportedCacheMissTokens != 0 {
		t.Fatalf("silent pair = %d/%d, want 0/0",
			silent.ReportedCacheHitTokens, silent.ReportedCacheMissTokens)
	}
	// The billing fallback stays intact: an unreported call is billed as a miss.
	if silent.CacheMissTokens != 500 {
		t.Fatalf("silent billing miss = %d, want 500 (fallback unchanged)", silent.CacheMissTokens)
	}
}

// One bucket can receive both kinds of call: reported counters keep summing while
// the billing fallback keeps its own, larger total.
func TestLedgerAccumulatesReportedAcrossMixedCalls(t *testing.T) {
	l := NewLedger()
	q := reportedTestQuote("executor", "axon/deepseek-flash")
	l.Add(q, UsageTokens{PromptTokens: 100, CacheHitTokens: 80, CacheMissTokens: 20, CacheReported: true}, time.Time{})
	l.Add(q, UsageTokens{PromptTokens: 300}, time.Time{})
	l.Add(q, UsageTokens{PromptTokens: 100, CacheHitTokens: 90, CacheMissTokens: 10, CacheReported: true}, time.Time{})

	ent := bucketBySource(t, l, "executor")
	if ent.ReportedCacheHitTokens != 170 || ent.ReportedCacheMissTokens != 30 {
		t.Fatalf("reported pair = %d/%d, want 170/30", ent.ReportedCacheHitTokens, ent.ReportedCacheMissTokens)
	}
	if ent.CacheMissTokens != 330 {
		t.Fatalf("billing miss = %d, want 330", ent.CacheMissTokens)
	}
	// Pricing must be unaffected by the marker: every call still bills.
	if ent.RequestCount != 3 {
		t.Fatalf("request count = %d, want 3", ent.RequestCount)
	}
}
