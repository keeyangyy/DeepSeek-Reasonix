import type { ContextInfo, UsageSourceStats, WireUsage } from "./types";

// Cache-hit rate displays for the status bar. Kept out of StatusBar.tsx so that
// component stays under its file-size budget.
//
// Every session-level figure reads the REPORTED pair (calls whose provider
// actually returned cache counters). A gateway that omits them leaves hit/miss
// at zero, which is "unknown", not "every prompt missed" — counting those as
// misses is what dragged a 99.5% session down to 97%.

function formatRate(hit: number, denom: number): string | null {
  return denom > 0 ? ((hit / denom) * 100).toFixed(2) : null;
}

// Single-turn prompt cache-hit % (latest turn) — the higher, steeper number on
// a non-compacting DeepSeek session. A turn whose provider omitted cache
// counters reports nothing rather than 0%.
export function nowRate(u?: WireUsage): string | null {
  if (!u || u.cacheReported === false) return null;
  return formatRate(u.cacheHitTokens, u.cacheHitTokens + u.cacheMissTokens);
}

// Executor-only session aggregate; the pre-first-refresh fallback for avgRate.
export function avgRate(u?: WireUsage): string | null {
  if (!u) return null;
  return formatRate(u.sessionCacheHitTokens, u.sessionCacheHitTokens + u.sessionCacheMissTokens);
}

// Reported pair wins; a bucket that saw new-format calls but none reported is
// unknown; one that never saw the marker keeps its legacy pair, so an upgrade
// does not blank out a number the user already had.
function resolveCachePair(
  reportedHit: number,
  reportedMiss: number,
  markerSeen: boolean,
  legacyHit: number,
  legacyMiss: number,
): [number, number] {
  if (reportedHit + reportedMiss > 0) return [reportedHit, reportedMiss];
  if (markerSeen) return [0, 0];
  return [legacyHit, legacyMiss];
}

// All-sources session aggregate from tab telemetry — matches the 会话费用
// tooltip scope (main model + subagents + auxiliary calls).
export function contextAvgRate(ctx: ContextInfo): string | null {
  const [hit, miss] = resolveCachePair(
    ctx.reportedCacheHitTokens ?? 0,
    ctx.reportedCacheMissTokens ?? 0,
    ctx.cacheMarkerSeen === true,
    ctx.cacheHitTokens ?? 0,
    ctx.cacheMissTokens ?? 0,
  );
  return formatRate(hit, hit + miss);
}

// Per-source row rate for the cache tooltip.
export function sourceCacheRate(stats: UsageSourceStats, notReported: string): string {
  const [hit, miss] = resolveCachePair(
    stats.reportedCacheHitTokens ?? 0,
    stats.reportedCacheMissTokens ?? 0,
    stats.cacheMarkerSeen === true,
    stats.cacheHitTokens,
    stats.cacheMissTokens,
  );
  return hit + miss > 0 ? `${formatRate(hit, hit + miss)}%` : notReported;
}