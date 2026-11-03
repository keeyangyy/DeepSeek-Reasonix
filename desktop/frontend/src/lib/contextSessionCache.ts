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

const UNKNOWN: SessionCacheFigures = { hit: 0, miss: 0, coverage: 0 };

export function contextSessionCache(
  info?: Pick<
    ContextPanelInfo,
    | "sessionCacheHitTokens"
    | "sessionCacheMissTokens"
    | "sessionReportedCacheHitTokens"
    | "sessionReportedCacheMissTokens"
    | "sessionCacheMarkerSeen"
  > | null,
  context?: Pick<ContextInfo, "cacheHitTokens" | "cacheMissTokens" | "cacheMarkerSeen">,
  usage?: Pick<WireUsage, "sessionCacheHitTokens" | "sessionCacheMissTokens">,
): SessionCacheFigures {
  const reportedHit = info?.sessionReportedCacheHitTokens ?? 0;
  const reportedMiss = info?.sessionReportedCacheMissTokens ?? 0;
  if (reportedHit + reportedMiss > 0) {
    const all = (info?.sessionCacheHitTokens ?? 0) + (info?.sessionCacheMissTokens ?? 0);
    const known = reportedHit + reportedMiss;
    return { hit: reportedHit, miss: reportedMiss, coverage: all > 0 ? known / all : 1 };
  }
  // The marker separates two cases that both show a zero reported pair:
  //   - seen:     every call omitted counters, so the rate is genuinely unknown
  //   - not seen: the session predates the marker; keep the legacy figure so an
  //               upgrade does not blank out a number the user had before
  if (info?.sessionCacheMarkerSeen || context?.cacheMarkerSeen) return UNKNOWN;
  const ctxHit = context?.cacheHitTokens ?? 0;
  const ctxMiss = context?.cacheMissTokens ?? 0;
  if (ctxHit + ctxMiss > 0) return { hit: ctxHit, miss: ctxMiss, coverage: 1 };
  const infoHit = info?.sessionCacheHitTokens ?? 0;
  const infoMiss = info?.sessionCacheMissTokens ?? 0;
  if (infoHit + infoMiss > 0) return { hit: infoHit, miss: infoMiss, coverage: 1 };
  const usageHit = usage?.sessionCacheHitTokens ?? 0;
  const usageMiss = usage?.sessionCacheMissTokens ?? 0;
  if (usageHit + usageMiss > 0) return { hit: usageHit, miss: usageMiss, coverage: 1 };
  return UNKNOWN;
}