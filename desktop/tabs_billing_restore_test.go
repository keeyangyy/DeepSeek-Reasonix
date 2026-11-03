package main

import (
	"path/filepath"
	"testing"
	"time"

	"reasonix/internal/billing"
)

// A session written before the read-side fix carries a bucket that never
// recorded a token count. Restoring it must re-aggregate the ledger instead of
// trusting the persisted completeness flag, otherwise the panel keeps showing
// "unavailable" for a session that does have priced turns.
func TestSyncTelemetryToSessionReaggregatesRestoredLedger(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "restored.jsonl")

	ledger := billing.NewLedger()
	ledger.Add(billing.CostQuote{
		Original:     billing.Money{Amount: "0", Currency: "CNY"},
		Valuations:   map[string]billing.Valuation{"CNY": {Money: billing.Money{Amount: "0", Currency: "CNY"}, Basis: billing.BasisIdentity}},
		CostComplete: false, DisplayComplete: false, Complete: false,
		DisplayStatus: billing.DisplayStatusUnavailable, IncompleteReason: "missing_price_or_usage",
		ModelRef: "axon/deepseek-flash", PricingFingerprint: "fp-empty",
	}, billing.UsageTokens{}, time.Time{})
	ledger.Add(billing.CostQuote{
		Original:     billing.Money{Amount: "1.5", Currency: "CNY"},
		Valuations:   map[string]billing.Valuation{"CNY": {Money: billing.Money{Amount: "1.5", Currency: "CNY"}, Basis: billing.BasisIdentity}},
		CostComplete: true, DisplayComplete: true, Complete: true,
		DisplayStatus: billing.DisplayStatusMatched, ModelRef: "axon/deepseek-flash-st", PricingFingerprint: "fp-priced",
	}, billing.UsageTokens{PromptTokens: 100}, time.Time{})

	snapshot := tabTelemetrySnapshot{Version: 3, Usage: sessionUsageStats{
		SessionCurrency: "CNY",
		// Persisted by the version that ran then: the bad bucket made it false.
		SessionCostComplete: false,
		SessionCost:         0,
		CostLedger:          ledger,
	}}
	if err := saveTelemetry(path+".telemetry.json", snapshot); err != nil {
		t.Fatalf("save telemetry: %v", err)
	}

	tab := &WorkspaceTab{}
	tab.syncTelemetryToSession(path)

	got := tab.displayTelemetrySnapshot().Usage
	if !got.SessionCostComplete || got.SessionCost != 1.5 {
		t.Fatalf("restored cost = %+v, want complete 1.5 CNY", got)
	}
}

// A sidecar without a ledger must keep its persisted cost untouched — the
// re-aggregation only applies when there is a ledger to read.
func TestSyncTelemetryToSessionLeavesLegacyCostAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy.jsonl")

	snapshot := tabTelemetrySnapshot{Version: 3, Usage: sessionUsageStats{
		SessionCurrency: "CNY", SessionCost: 2.5, SessionCostComplete: true,
	}}
	if err := saveTelemetry(path+".telemetry.json", snapshot); err != nil {
		t.Fatalf("save telemetry: %v", err)
	}

	tab := &WorkspaceTab{}
	tab.syncTelemetryToSession(path)

	got := tab.displayTelemetrySnapshot().Usage
	if got.SessionCost != 2.5 || !got.SessionCostComplete {
		t.Fatalf("legacy cost = %+v, want untouched 2.5 CNY", got)
	}
}
