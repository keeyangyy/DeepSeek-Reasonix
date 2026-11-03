import type { Translator } from "./i18n";
import type { ContextPanelInfo, UsageSourceStats } from "./types";

// Source-row projection for the context panel. Lives here rather than in
// ContextPanel.tsx so the panel stays under the file-size budget, and exports
// both the billing pair and the reported pair: the panel shows the reported one
// (calls whose gateway omitted cache counters are unknown, not misses).
const SOURCE_ORDER = ["executor", "planner", "subagent", "compaction", "classifier", "title"];

export function sourceTone(source: string): string {
  switch (source) {
    case "executor": return "teal";
    case "planner": return "blue";
    case "subagent": return "amber";
    case "compaction": return "slate";
    case "classifier": return "violet";
    case "title": return "rose";
    default: return "default";
  }
}

export function sourceLabel(source: string, t: Translator): string {
  switch (source) {
    case "executor": return t("context.sourceExecutor");
    case "planner": return t("context.sourcePlanner");
    case "subagent": return t("context.sourceSubagent");
    case "compaction": return t("context.sourceCompaction");
    case "classifier": return t("context.sourceClassifier");
    case "title": return t("context.sourceTitle");
    default: return source;
  }
}

function sourceCost(stats: UsageSourceStats): number {
  return typeof stats.sessionCost === "number" ? stats.sessionCost : stats.sessionCostUsd ?? 0; // 0 is a real price
}

export function sourceTokenTotal(row: Pick<ContextSourceRow, "promptTokens" | "completionTokens" | "totalTokens">): number {
  return row.totalTokens > 0 ? row.totalTokens : row.promptTokens + row.completionTokens;
}

export interface ContextSourceRow {
  source: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reportedCacheHitTokens?: number;
  reportedCacheMissTokens?: number;
  cacheMarkerSeen?: boolean;
  totalTokens: number;
  cost: number;
  currency?: string;
  requests: number;
  estimated: boolean;
}

// SourceRow cache pair for the hit-rate display. Mirrors contextSessionCache:
// reported calls win; a bucket that never saw a new-format call keeps the
// billing pair it already carried, so an upgrade does not blank out history.
export function sourceCacheFigures(row: ContextSourceRow): { hit: number; miss: number } {
  const reportedHit = row.reportedCacheHitTokens ?? 0;
  const reportedMiss = row.reportedCacheMissTokens ?? 0;
  if (reportedHit + reportedMiss > 0) return { hit: reportedHit, miss: reportedMiss };
  if (row.cacheMarkerSeen) return { hit: 0, miss: 0 };
  return { hit: row.cacheHitTokens, miss: row.cacheMissTokens };
}

export function contextSourceRows(info: ContextPanelInfo | null, sessionCurrency?: string): ContextSourceRow[] {
  const entries = Object.entries(info?.sources ?? {});
  if (entries.length === 0) return [];
  return entries
    .filter(([, stats]) =>
      (stats.requestCount ?? 0) > 0 ||
      (stats.promptTokens ?? 0) > 0 ||
      (stats.completionTokens ?? 0) > 0 ||
      (stats.cacheHitTokens ?? 0) > 0 ||
      (stats.cacheMissTokens ?? 0) > 0 ||
      sourceCost(stats) > 0
    )
    .sort(([a], [b]) => {
      const ia = SOURCE_ORDER.indexOf(a);
      const ib = SOURCE_ORDER.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia >= 0 ? ia : SOURCE_ORDER.length) - (ib >= 0 ? ib : SOURCE_ORDER.length);
      return a.localeCompare(b);
    })
    .map(([source, stats]) => ({
      source,
      label: source,
      promptTokens: stats.promptTokens ?? 0,
      completionTokens: stats.completionTokens ?? 0,
      cacheHitTokens: stats.cacheHitTokens ?? 0,
      cacheMissTokens: stats.cacheMissTokens ?? 0,
      reportedCacheHitTokens: stats.reportedCacheHitTokens ?? 0,
      reportedCacheMissTokens: stats.reportedCacheMissTokens ?? 0,
      cacheMarkerSeen: stats.cacheMarkerSeen === true,
      totalTokens: stats.totalTokens ?? 0,
      cost: sourceCost(stats),
      currency: stats.sessionCurrency || sessionCurrency || info?.sessionCurrency,
      requests: stats.requestCount ?? 0,
      estimated: stats.estimated === true,
    }));
}