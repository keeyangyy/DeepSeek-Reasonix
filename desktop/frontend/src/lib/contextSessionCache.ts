import type { ContextInfo, ContextPanelInfo, WireUsage } from "./types";

// contextSessionCache picks the session-cumulative cache figures for the
// panel's session average. Two pairs exist now:
//   - reported: only calls whose provider actually returned cache counters
//   - all:      the billing fallback, which counts unreported calls as misses
// Hit-rate readers must use the reported pair, otherwise a gateway that omits
// cache fields (e.g. ModelScope behind AxonHub) drags the rate to zero. The
// coverage fraction says how much of the session's prompt volume the reported
// pair actually covers, so a low-coverage rate cannot be mistaken for a global
// one. Both numbers always come from one source, never mixed.
export interface SessionCacheFigures {
  hit: number;
  miss: number;
  /** 0..1 share of prompt tokens covered by the reported pair; 0 = nothing reported. */
  coverage: number;
}

export function contextSessionCache(
  info?: Pick<
    ContextPanelInfo,
    | "sessionCacheHitTokens"
    | "sessionCacheMissTokens"
    | "sessionReportedCacheHitTokens"
    | "sessionReportedCacheMissTokens"
  > | null,
  context?: Pick<ContextInfo, "cacheHitTokens" | "cacheMissTokens">,
  usage?: Pick<WireUsage, "sessionCacheHitTokens" | "sessionCacheMissTokens">,
): SessionCacheFigures {
  const reportedHit = info?.sessionReportedCacheHitTokens ?? 0;
  const reportedMiss = info?.sessionReportedCacheMissTokens ?? 0;
  if (reportedHit + reportedMiss > 0) {
    const all = (info?.sessionCacheHitTokens ?? 0) + (info?.sessionCacheMissTokens ?? 0);
    const known = reportedHit + reportedMiss;
    return { hit: reportedHit, miss: reportedMiss, coverage: all > 0 ? known / all : 1 };
  }
  // Panel telemetry exists but carries no reported pair: either the session
  // predates the marker or every call omitted cache counters. Report "unknown"
  // instead of surfacing the billing fallback as a real 0% hit rate.
  if (info && (info.sessionCacheHitTokens ?? 0) + (info.sessionCacheMissTokens ?? 0) > 0) {
    return { hit: 0, miss: 0, coverage: 0 };
  }
  // Panel has not refreshed yet: bridge with live counters, which predate the
  // marker and so cannot distinguish reported from unreported calls.
  const ctxHit = context?.cacheHitTokens ?? 0;
  const ctxMiss = context?.cacheMissTokens ?? 0;
  if (ctxHit + ctxMiss > 0) return { hit: ctxHit, miss: ctxMiss, coverage: 1 };
  return {
    hit: usage?.sessionCacheHitTokens ?? 0,
    miss: usage?.sessionCacheMissTokens ?? 0,
    coverage: 1,
  };
}
