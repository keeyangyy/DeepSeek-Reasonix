// Release-version analysis, adoption metrics, and the /stats dashboard handler.
import type { User } from "./auth";
import { crashStorageMode } from "./crash_delivery";
import {
  crashGroups,
  currentWindowSince,
  diagnosticFacets as loadDiagnosticFacets,
  diagnosticWindowWhere,
  developmentGroupSQL,
  type DiagnosticFacets,
} from "./diagnostics_v2";
import type { Env } from "./env";
import { firebaseStorageSummary, type FirebaseStorageSummary } from "./firebase_lifecycle";
import { html } from "./shell";
import { renderStats, type StatsModule } from "./stats";
import { statsFilters } from "./stats_filters";
import { statsQueryObserver } from "./stats_timing";
import { ensureCLITelemetrySchema, telemetryTableNames, type ClientSurfaceName } from "./telemetry";

type ParsedVersion = {
  version: string;
  major: number;
  minor: number;
  patch: number;
};

function parseReleaseVersion(version: string): ParsedVersion | null {
  // The dashboard's "latest" lane is for shipped stable builds. Development,
  // prerelease, and build-metadata values remain visible in version facets but
  // must not become the release baseline used for regression triage.
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    version,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

export function newestReleaseVersion(versions: string[]): string {
  const parsed = versions
    .filter((v) => v && v.toLowerCase() !== "dev")
    .map(parseReleaseVersion)
    .filter((v): v is ParsedVersion => v !== null);
  parsed.sort(
    (a, b) =>
      b.major - a.major ||
      b.minor - a.minor ||
      b.patch - a.patch ||
      b.version.localeCompare(a.version),
  );
  return parsed[0]?.version ?? "";
}

async function latestObservedVersion(env: Env, surface: ClientSurfaceName): Promise<string> {
  const table = telemetryTableNames(surface).pings;
  // Require independent installations and use pings as the sole source of
  // release truth. A single synthetic diagnostic must never promote v9.9.9 (or
  // a prerelease) to "latest" for every report group.
  const sql = `SELECT version FROM ${table}
    WHERE date >= date('now', '-29 day') AND version <> ''
    GROUP BY version HAVING COUNT(DISTINCT install_id) >= 2`;
  const rows = await env.DB.prepare(sql).all<{ version: string }>();
  return newestReleaseVersion(rows.results.map((r) => r.version));
}

type OverviewCounts = {
  latestAdoptionPct: number | null;
  openReports: number;
  newLatestReports: number;
  regressedReports: number;
  criticalOpenReports: number;
};

async function latestAdoptionPct(env: Env, latestVersion: string, days: 7 | 30, surface: ClientSurfaceName): Promise<number | null> {
  if (!latestVersion) return null;
  const table = telemetryTableNames(surface).pings;
  const row = await env.DB.prepare(
    `SELECT
      COUNT(DISTINCT install_id) AS total_installs,
      COUNT(DISTINCT CASE WHEN version = ?1 THEN install_id END) AS latest_installs
    FROM ${table} WHERE date >= date('now', '${currentWindowSince(days)}')`,
  )
    .bind(latestVersion)
    .first<{ total_installs: number; latest_installs: number }>();
  const total = Number(row?.total_installs ?? 0);
  if (!total) return null;
  return (Number(row?.latest_installs ?? 0) / total) * 100;
}

async function diagnosticOverview(env: Env, latestVersion: string, days: 7 | 30, surface: ClientSurfaceName): Promise<OverviewCounts> {
  if (surface === "cli") {
    return {
      latestAdoptionPct: await latestAdoptionPct(env, latestVersion, days, surface),
      openReports: 0,
      newLatestReports: 0,
      regressedReports: 0,
      criticalOpenReports: 0,
    };
  }
  // Keep the overview's red state aligned with the effective severity used by
  // the diagnostics list. Historical rows retain their stored severity, so
  // known browser notices and development builds must be discounted here too.
  const criticalActionable = `(severity = 'critical' OR (
    severity = 'high'
    AND kind <> 'performance'
    AND NOT ${developmentGroupSQL}
    AND title <> '[window.error] Script error.'
    AND title NOT LIKE '%ResizeObserver loop %'
    AND title NOT LIKE '%Minified React error #520%'
    AND title NOT LIKE '%additional File object is not a file on the disk%'
  ))`;
  const diagnosticCounts = latestVersion
    ? env.DB.prepare(
        `SELECT
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_reports,
          SUM(CASE WHEN first_version = ?1 THEN 1 ELSE 0 END) AS new_latest_reports,
          SUM(CASE WHEN regressed_at <> '' THEN 1 ELSE 0 END) AS regressed_reports,
          SUM(CASE WHEN status = 'open' AND ${criticalActionable} THEN 1 ELSE 0 END) AS critical_open_reports
        FROM groups WHERE ${diagnosticWindowWhere(days)}`,
      )
        .bind(latestVersion)
        .first<{ open_reports: number; new_latest_reports: number; regressed_reports: number; critical_open_reports: number }>()
    : env.DB.prepare(
        `SELECT
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_reports,
          0 AS new_latest_reports,
          SUM(CASE WHEN regressed_at <> '' THEN 1 ELSE 0 END) AS regressed_reports,
          SUM(CASE WHEN status = 'open' AND ${criticalActionable} THEN 1 ELSE 0 END) AS critical_open_reports
        FROM groups WHERE ${diagnosticWindowWhere(days)}`,
      ).first<{ open_reports: number; new_latest_reports: number; regressed_reports: number; critical_open_reports: number }>();
  const [row, adoptionPct] = await Promise.all([
    diagnosticCounts,
    latestAdoptionPct(env, latestVersion, days, surface),
  ]);
  return {
    latestAdoptionPct: adoptionPct,
    openReports: Number(row?.open_reports ?? 0),
    newLatestReports: Number(row?.new_latest_reports ?? 0),
    regressedReports: Number(row?.regressed_reports ?? 0),
    criticalOpenReports: Number(row?.critical_open_reports ?? 0),
  };
}

function previousWindowSince(days: 7 | 30): string {
  return `-${days * 2 - 1} day`;
}

function previousWindowUntil(days: 7 | 30): string {
  return currentWindowSince(days);
}

async function metricRows(env: Env, days: 7 | 30, surface: ClientSurfaceName, previous = false): Promise<{ signal: string; bucket: string; total: number }[]> {
  const where = previous
    ? `date >= date('now', '${previousWindowSince(days)}') AND date < date('now', '${previousWindowUntil(days)}')`
    : `date >= date('now', '${currentWindowSince(days)}')`;
  const table = telemetryTableNames(surface).metrics;
  const rows = await env.DB.prepare(
    `SELECT signal, bucket, SUM(count) AS total FROM ${table} WHERE ${where} GROUP BY signal, bucket ORDER BY signal, total DESC`,
  ).all<{ signal: string; bucket: string; total: number }>();
  return rows.results;
}

type Bar = { label: string; users: number };
type MetricTotals = { signal: string; bucket: string; total: number }[];
// Each stats module renders only its own section, so a page load queries only
// what that section shows.
export async function handleStats(request: Request, env: Env, user: User, activeModule: StatsModule): Promise<Response> {
  const url = new URL(request.url);
  const filters = statsFilters(url);
  const days = filters.windowDays;
  const since = currentWindowSince(days);
  const surface = activeModule === "diagnostics" ? "desktop" : filters.surface;
  if (activeModule === "diagnostics") filters.surface = "desktop";
  if (surface === "cli") await ensureCLITelemetrySchema(env);
  const pingsTable = telemetryTableNames(surface).pings;
  const bars = (sql: string) => env.DB.prepare(sql).all<Bar>().then((r) => r.results);
  const pingVersions = () =>
    bars(`SELECT version AS label, COUNT(DISTINCT install_id) AS users FROM ${pingsTable} WHERE date >= date('now', '${since}') GROUP BY label ORDER BY users DESC LIMIT 15`);
  const pingPlatforms = () =>
    bars(`SELECT os || ' ' || arch AS label, COUNT(DISTINCT install_id) AS users FROM ${pingsTable} WHERE date >= date('now', '${since}') GROUP BY label ORDER BY users DESC`);

  let daily: { date: string; users: number; opens: number }[] = [];
  let versions: Bar[] = [];
  let platforms: Bar[] = [];
  let crashes: Awaited<ReturnType<typeof crashGroups>>["results"] = [];
  let metrics: MetricTotals = [];
  let previousMetrics: MetricTotals = [];
  let sources: Bar[] = [];
  let diagnosticFacets: DiagnosticFacets = {
    versions: [], platforms: [],
    osBuilds: [], osRevisions: [], distros: [], distroVersions: [], kernels: [], sessions: [],
    architectures: [], channels: [], runtimes: [], runtimeEngines: [],
    failureKinds: [], failureReasons: [], exitCodes: [], recoveries: [], gpuStates: [],
  };
  let installationLinkedSince = "";
  let overview: OverviewCounts = {
    latestAdoptionPct: null,
    openReports: 0,
    newLatestReports: 0,
    regressedReports: 0,
    criticalOpenReports: 0,
  };
  let latestVersion = "";
  let firebaseStorage: FirebaseStorageSummary | undefined;

  if (activeModule === "usage") {
    latestVersion = await latestObservedVersion(env, surface);
    const [dailyR, versionsR, platformsR, metricsR, overviewR] = await Promise.all([
      env.DB.prepare(
        `SELECT date, COUNT(*) AS users, SUM(opens) AS opens FROM ${pingsTable} WHERE date >= date('now', '${since}') GROUP BY date`,
      ).all<{ date: string; users: number; opens: number }>(),
      pingVersions(),
      pingPlatforms(),
      metricRows(env, days, surface),
      diagnosticOverview(env, latestVersion, days, surface),
    ]);
    daily = dailyR.results;
    versions = versionsR;
    platforms = platformsR;
    metrics = metricsR;
    overview = overviewR;
  } else if (activeModule === "diagnostics") {
    latestVersion = await latestObservedVersion(env, "desktop");
    const [crashesR, sourcesR, facets, linkedSince] = await Promise.all([
      crashGroups(env, filters, latestVersion, statsQueryObserver("/stats/diagnostics")),
      bars(`SELECT source AS label, COUNT(*) AS users FROM groups WHERE ${diagnosticWindowWhere(days)} GROUP BY source ORDER BY users DESC`),
      loadDiagnosticFacets(env, days, statsQueryObserver("/stats/diagnostics")),
      env.DB.prepare("SELECT value FROM diagnostics_meta WHERE key = 'installation_linked_since'").first<{ value: string }>(),
    ]);
    crashes = crashesR.results;
    sources = sourcesR;
    versions = facets.versions;
    platforms = facets.platforms;
    diagnosticFacets = facets;
    installationLinkedSince = linkedSince?.value ?? "";
    if (crashStorageMode(env) !== "d1") firebaseStorage = await firebaseStorageSummary(env);
  } else if (activeModule === "preferences") {
    metrics = await metricRows(env, days, surface);
  } else {
    const [metricsR, previousMetricsR] = await Promise.all([
      metricRows(env, days, surface),
      metricRows(env, days, surface, true),
    ]);
    metrics = metricsR;
    previousMetrics = previousMetricsR;
  }

  return html(
    renderStats(
      { daily, versions, platforms, crashes, metrics, previousMetrics, sources, diagnosticFacets,
        installationLinkedSince, overview, latestVersion, filters, firebaseStorage },
      user,
      activeModule,
    ),
  );
}
