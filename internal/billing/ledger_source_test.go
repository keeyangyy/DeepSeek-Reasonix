package billing

import (
	"testing"
	"time"
)

// The panel shows a session total and a per-source breakdown directly under it,
// so the two must always agree. Deriving both from the same ledger is what
// guarantees it; a separately accumulated per-source sum drifts the moment one
// update cannot be aggregated.
func TestTotalsBySourceSumsToLedgerTotal(t *testing.T) {
	l := NewLedger()
	add := func(model, source, amount string, tokens UsageTokens) {
		q := CostQuote{
			Original:     Money{Amount: amount, Currency: "CNY"},
			Valuations:   map[string]Valuation{"CNY": {Money: Money{Amount: amount, Currency: "CNY"}, Basis: BasisIdentity}},
			CostComplete: true, DisplayComplete: true, Complete: true,
			DisplayStatus: DisplayStatusMatched, ModelRef: model, UsageSource: source,
			PricingFingerprint: "fp-" + source,
		}
		l.Add(q, tokens, time.Time{})
	}
	add("axon/deepseek-flash", "executor", "20.89", UsageTokens{PromptTokens: 600_000_000})
	add("axon/deepseek-flash", "compaction", "0.16", UsageTokens{PromptTokens: 2_000_000})
	add("axon/deepseek-flash", "title", "0.004", UsageTokens{PromptTokens: 247})
	// A bucket with no cost fact: it must not appear in either place.
	l.Add(CostQuote{
		Original: Money{}, Valuations: map[string]Valuation{},
		IncompleteReason: "no_price", ModelRef: "axon/deepseek-flash",
		UsageSource: "title-unpriced", PricingFingerprint: "fp-empty",
	}, UsageTokens{PromptTokens: 100}, time.Time{})

	total := l.Total("CNY")
	if total.Selected == nil || !total.Complete {
		t.Fatalf("total = %+v, want complete", total)
	}
	bySource := l.TotalsBySource("CNY")

	var sum float64
	for _, agg := range bySource {
		if agg.Selected != nil {
			sum += agg.Selected.Float64()
		}
	}
	if got, want := sum, total.Selected.Float64(); absDiff(got, want) > 1e-6 {
		t.Fatalf("source sum = %f, total = %f — breakdown must add up", got, want)
	}
	if _, ok := bySource["title-unpriced"]; ok {
		t.Fatalf("bucket without a cost fact leaked into the breakdown: %v", bySource["title-unpriced"])
	}
	if len(bySource) != 3 {
		t.Fatalf("sources = %d, want 3", len(bySource))
	}
}

// An empty ledger yields no groups rather than a zero entry per source.
func TestTotalsBySourceEmptyLedger(t *testing.T) {
	if got := NewLedger().TotalsBySource("CNY"); len(got) != 0 {
		t.Fatalf("empty ledger groups = %v, want none", got)
	}
	var nilLedger *Ledger
	if got := nilLedger.TotalsBySource("CNY"); len(got) != 0 {
		t.Fatalf("nil ledger groups = %v, want none", got)
	}
}

func absDiff(a, b float64) float64 {
	if a > b {
		return a - b
	}
	return b - a
}
