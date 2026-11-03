package main

import (
	"time"

	"reasonix/internal/billing"
	"reasonix/internal/control"
	"reasonix/internal/provider"
)

func (a *App) balanceRequestTarget(tabID string) (*WorkspaceTab, control.SessionAPI, uint64) {
	a.mu.RLock()
	tab := a.tabByIDLocked(tabID)
	var ctrl control.SessionAPI
	if tab != nil {
		ctrl = tab.Ctrl
	}
	a.mu.RUnlock()
	if tab == nil || ctrl == nil {
		return nil, nil, 0
	}
	return tab, ctrl, tab.runtimeDisplayGeneration()
}

func (a *App) applyBalanceDisplayHint(tabID string, target *WorkspaceTab, ctrl control.SessionAPI, requested, primary string, generation uint64) {
	if requested != "" || primary == "" || a.balanceDisplayCurrency() != "" {
		return
	}
	// A response from an old tab, model, session, or display preference may
	// never rebind the current session.
	a.mu.RLock()
	current := a.tabByIDLocked(tabID)
	currentController := current != nil && current.Ctrl == ctrl
	a.mu.RUnlock()
	if current == target && currentController {
		target.selectRuntimeDisplayCurrencyAtGeneration(primary, generation)
	}
}

func (t *WorkspaceTab) replaceTelemetry(snapshot tabTelemetrySnapshot, sessionKey string) {
	if t == nil {
		return
	}
	t.telemMu.Lock()
	t.readTelemetry = append([]readFileRecord(nil), snapshot.ReadFiles...)
	t.usageTelemetry = cloneSessionUsageStats(snapshot.Usage)
	t.runtimeCostDisplayCurrency = ""
	t.runtimeCostQuote = nil
	t.runtimeCostGeneration++
	t.telemetrySessionKey = sessionKey
	t.telemMu.Unlock()
}

// selectDisplayCurrency rebinds occurrence-time valuations without repricing.
func (t *WorkspaceTab) selectDisplayCurrency(display string) bool {
	if t == nil {
		return false
	}
	t.telemMu.Lock()
	defer t.telemMu.Unlock()
	display = billing.NormalizeCurrency(display)
	t.runtimeCostDisplayCurrency = ""
	t.runtimeCostQuote = nil
	t.runtimeCostGeneration++
	if t.usageTelemetry.CostLedger == nil || len(t.usageTelemetry.CostLedger.Entries) == 0 {
		if t.usageTelemetry.SessionCost <= 0 {
			return true
		}
		occurred := time.Now().UTC()
		quote := billing.MigrateLegacyUsage(billing.LegacyUsageRecord{
			SessionCost:     t.usageTelemetry.SessionCost,
			SessionCurrency: t.usageTelemetry.SessionCurrency,
			EndedAt:         occurred,
		})
		t.usageTelemetry.CostLedger = billing.NewLedger()
		t.usageTelemetry.CostLedger.Add(quote, billing.UsageTokens{
			PromptTokens:     t.usageTelemetry.PromptTokens,
			CompletionTokens: t.usageTelemetry.CompletionTokens,
		}, occurred)
	}
	total := t.usageTelemetry.CostLedger.SelectDisplay(display)
	t.usageTelemetry.SessionCostQuote = &total
	t.usageTelemetry.SessionCostComplete = total.Complete
	if total.Selected == nil {
		t.usageTelemetry.SessionCostComplete = false
		t.usageTelemetry.SessionCost = 0
		t.usageTelemetry.SessionCurrency = ""
		t.usageTelemetry.SessionCostUsd = 0
		return true
	}
	t.usageTelemetry.SessionCost = total.Selected.Float64()
	t.usageTelemetry.SessionCurrency = total.LegacyCurrencyCode()
	t.usageTelemetry.SessionCostUsd = t.usageTelemetry.SessionCost
	return true
}

// selectRuntimeDisplayCurrency applies an automatic wallet hint only to the
// live tab/session. It never mutates the persisted telemetry or configuration.
func (t *WorkspaceTab) selectRuntimeDisplayCurrency(display string) bool {
	if t == nil {
		return false
	}
	t.telemMu.Lock()
	defer t.telemMu.Unlock()
	return t.selectRuntimeDisplayCurrencyLocked(display)
}

// selectRuntimeDisplayCurrencyAtGeneration applies an asynchronous wallet
// hint only if the tab/session display binding is still the one that started
// the balance request.
func (t *WorkspaceTab) selectRuntimeDisplayCurrencyAtGeneration(display string, generation uint64) bool {
	if t == nil {
		return false
	}
	t.telemMu.Lock()
	defer t.telemMu.Unlock()
	if t.runtimeCostGeneration != generation {
		return false
	}
	return t.selectRuntimeDisplayCurrencyLocked(display)
}

func (t *WorkspaceTab) selectRuntimeDisplayCurrencyLocked(display string) bool {
	display = billing.NormalizeCurrency(display)
	t.runtimeCostDisplayCurrency = display
	t.runtimeCostQuote = nil
	if t.usageTelemetry.CostLedger != nil && len(t.usageTelemetry.CostLedger.Entries) > 0 {
		total := t.usageTelemetry.CostLedger.SelectDisplay(display)
		t.runtimeCostQuote = &total
		return true
	}
	if t.usageTelemetry.SessionCost > 0 {
		quote := billing.MigrateLegacyUsage(billing.LegacyUsageRecord{
			SessionCost:     t.usageTelemetry.SessionCost,
			SessionCurrency: t.usageTelemetry.SessionCurrency,
			EndedAt:         time.Now().UTC(),
		})
		total := billing.AggregateQuotes([]billing.CostQuote{quote}, display)
		t.runtimeCostQuote = &total
	}
	return true
}

func (t *WorkspaceTab) runtimeDisplayGeneration() uint64 {
	if t == nil {
		return 0
	}
	t.telemMu.Lock()
	defer t.telemMu.Unlock()
	return t.runtimeCostGeneration
}

func (t *WorkspaceTab) clearRuntimeDisplayCurrency() {
	if t == nil {
		return
	}
	t.telemMu.Lock()
	t.runtimeCostDisplayCurrency = ""
	t.runtimeCostQuote = nil
	t.runtimeCostGeneration++
	t.telemMu.Unlock()
}

// repriceUsage preserves the legacy call shape as a display-only rebind.
func (t *WorkspaceTab) repriceUsage(pricingBySource map[string]*provider.Pricing) bool {
	_ = pricingBySource
	display := ""
	if t != nil {
		display = billing.NormalizeCurrency(t.usageTelemetry.SessionCurrency)
	}
	return t.selectDisplayCurrency(display)
}

// refreshRestoredCostQuoteLocked re-aggregates the restored ledger instead of
// trusting the persisted completeness flag, which was written by whichever
// version ran then. Read-side fixes (skipping buckets that never recorded a
// token count) only reach old sessions through this recompute: the panel shows
// the runtime quote when present and falls back to the snapshot otherwise.
// Caller holds telemMu.
func (t *WorkspaceTab) refreshRestoredCostQuoteLocked() {
	// Clear first: a session without a ledger must not inherit the previous
	// session's runtime quote.
	t.runtimeCostQuote = nil
	ledger := t.usageTelemetry.CostLedger
	if ledger == nil || len(ledger.Entries) == 0 {
		return
	}
	display := billing.NormalizeCurrency(t.usageTelemetry.SessionCurrency)
	total := ledger.Total(display)
	t.runtimeCostQuote = &total
	t.usageTelemetry.SessionCostQuote = &total
	t.usageTelemetry.SessionCostComplete = total.Complete
	if total.Selected != nil {
		t.usageTelemetry.SessionCost = total.Selected.Float64()
		t.usageTelemetry.SessionCurrency = total.LegacyCurrencyCode()
		t.usageTelemetry.SessionCostUsd = t.usageTelemetry.SessionCost
	}
}

// displayTelemetrySnapshot overlays the live wallet hint onto a copy used by
// UI reads. The persisted snapshot remains the occurrence-time/original view.
func (t *WorkspaceTab) displayTelemetrySnapshot() tabTelemetrySnapshot {
	snapshot := t.telemetrySnapshot()
	t.telemMu.Lock()
	quote := t.runtimeCostQuote
	ledger := t.usageTelemetry.CostLedger
	display := billing.NormalizeCurrency(t.runtimeCostDisplayCurrency)
	if display == "" {
		display = billing.NormalizeCurrency(t.usageTelemetry.SessionCurrency)
	}
	t.telemMu.Unlock()
	// A restored session may have no runtime quote yet (syncTelemetryToSession
	// returns early on a matching key), and the persisted quote can still say
	// "unavailable". Aggregate here so opening shows the price immediately.
	if quote == nil && ledger != nil && len(ledger.Entries) > 0 {
		fresh := ledger.Total(display)
		quote = &fresh
	}
	// Derive per-source amounts from the ledger — the same source the session
	// total comes from. A separately accumulated sum drifts once one update
	// cannot be aggregated, leaving a breakdown that no longer adds up.
	if ledger != nil && len(ledger.Entries) > 0 {
		bySource := ledger.TotalsBySource(display)
		for source, stats := range snapshot.Usage.Sources {
			if agg, ok := bySource[source]; ok && agg.Selected != nil {
				stats.SessionCost = agg.Selected.Float64()
				stats.SessionCostUsd = stats.SessionCost
				stats.SessionCurrency = agg.LegacyCurrencySymbol()
			} else {
				stats.SessionCost = 0
				stats.SessionCostUsd = 0
			}
			snapshot.Usage.Sources[source] = stats
		}
	}
	if quote == nil {
		return snapshot
	}
	snapshot.Usage.SessionCostQuote = quote
	snapshot.Usage.SessionCostComplete = quote.Complete
	if quote.Selected != nil {
		snapshot.Usage.SessionCost = quote.Selected.Float64()
		snapshot.Usage.SessionCurrency = quote.LegacyCurrencyCode()
		snapshot.Usage.SessionCostUsd = snapshot.Usage.SessionCost
	} else {
		snapshot.Usage.SessionCostComplete = false
		snapshot.Usage.SessionCost = 0
		snapshot.Usage.SessionCurrency = ""
		snapshot.Usage.SessionCostUsd = 0
	}
	return snapshot
}

// addReportedCache accumulates cache counters only for calls whose provider
// actually reported them. Billing keeps treating unknown calls as fully
// uncached input; hit-rate displays read this pair instead, so a gateway that
// omits cache fields cannot drag the rate down to zero.
func (s *sessionUsageStats) addReportedCache(reported bool, hit, miss int) {
	if !reported {
		return
	}
	s.ReportedCacheHitTokens += hit
	s.ReportedCacheMissTokens += miss
}

// addReportedCache is the per-source equivalent used by the panel's source rows.
func (s *usageSourceStats) addReportedCache(reported bool, hit, miss int) {
	if !reported {
		return
	}
	s.ReportedCacheHitTokens += hit
	s.ReportedCacheMissTokens += miss
}
