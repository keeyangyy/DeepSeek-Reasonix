// Telemetry ingest schemas (pings + metrics payloads) and the CLI telemetry table layout.
import { z } from "zod";
import type { Env } from "./env";

const ClientSurface = z.enum(["desktop", "cli"]);
export type ClientSurfaceName = z.infer<typeof ClientSurface>;

type TelemetryTableNames = {
  pings: "pings" | "cli_pings";
  metrics: "metrics" | "cli_metrics";
};

const TELEMETRY_TABLES: Record<ClientSurfaceName, TelemetryTableNames> = {
  desktop: { pings: "pings", metrics: "metrics" },
  cli: { pings: "cli_pings", metrics: "cli_metrics" },
};

export function telemetryTableNames(surface: ClientSurfaceName): TelemetryTableNames {
  return TELEMETRY_TABLES[surface];
}

export const CLI_TELEMETRY_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS cli_pings (
     date TEXT NOT NULL,
     install_id TEXT NOT NULL,
     version TEXT NOT NULL,
     os TEXT NOT NULL,
     arch TEXT NOT NULL,
     os_version TEXT NOT NULL DEFAULT '',
     os_build INTEGER NOT NULL DEFAULT 0,
     os_revision INTEGER NOT NULL DEFAULT 0,
     channel TEXT NOT NULL DEFAULT '',
     distro_id TEXT NOT NULL DEFAULT '',
     distro_version TEXT NOT NULL DEFAULT '',
     kernel_version TEXT NOT NULL DEFAULT '',
     session_type TEXT NOT NULL DEFAULT '',
     runtime_engine TEXT NOT NULL DEFAULT '',
     runtime_version TEXT NOT NULL DEFAULT '',
     gpu_mode TEXT NOT NULL DEFAULT '',
     opens INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (date, install_id)
   )`,
  `CREATE TABLE IF NOT EXISTS cli_metrics (
     date TEXT NOT NULL,
     version TEXT NOT NULL,
     os TEXT NOT NULL,
     signal TEXT NOT NULL,
     bucket TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, version, os, signal, bucket)
   )`,
  // No secondary indexes: each primary key already leads with `date`, which is
  // what every dashboard query filters on. See migrate-window-index-fix.sql.
] as const;

const cliTelemetrySchemaPromises = new WeakMap<object, Promise<void>>();

export function ensureCLITelemetrySchema(env: Pick<Env, "DB">): Promise<void> {
  const key = env.DB as unknown as object;
  const existing = cliTelemetrySchemaPromises.get(key);
  if (existing) return existing;
  const creation = env.DB
    .batch(CLI_TELEMETRY_SCHEMA_SQL.map((sql) => env.DB.prepare(sql)))
    .then(() => undefined)
    .catch((err) => {
      cliTelemetrySchemaPromises.delete(key);
      throw err;
    });
  cliTelemetrySchemaPromises.set(key, creation);
  return creation;
}

export const Ping = z.object({
  installId: z.string().regex(/^[0-9a-f]{32}$/),
  version: z.string().min(1).max(64),
  os: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  osVersion: z.string().max(128).optional(),
  osBuild: z.number().int().min(0).max(1_000_000).optional(),
  osRevision: z.number().int().min(0).max(1_000_000).optional(),
  channel: z.string().max(32).optional(),
  distroId: z.string().max(64).optional(),
  distroVersion: z.string().max(64).optional(),
  kernelVersion: z.string().max(128).optional(),
  sessionType: z.enum(["wayland", "x11", "remote", "unknown"]).optional(),
  runtimeEngine: z.enum(["webview2", "webkitgtk", "unknown"]).optional(),
  runtimeVersion: z.string().max(128).optional(),
  gpuMode: z.enum(["enabled", "disabled", "always", "on_demand", "unknown"]).optional(),
  surface: ClientSurface.default("desktop"),
});

// Opt-in aggregate client metrics: a per-launch snapshot of (signal, bucket)
// counters. The optional surface-specific random install id deduplicates DAU;
// there is no user content. Unknown signals are discarded before storage so
// older workers can accept batches from newer clients safely.
const METRIC_SIGNALS = [
  "finish_reason",
  "empty_final",
  "provider_error",
  "cache_hit",
  "tool_error",
  "updater_error",
  "updater_event",
  "compaction",
  "turns",
  "desktop_hang",
  "desktop_hang_age",
  "desktop_exit",
  "desktop_exit_phase",
  "desktop_uptime",
  "desktop_install",
  "desktop_update_transition",
  "desktop_restore",
  "desktop_webview2_failure",
  "desktop_webview2_outcome",
  "desktop_web_runtime_failure",
  "desktop_web_runtime_outcome",
  "desktop_web_runtime_dropped",
  "desktop_legacy_exit",
  "desktop_legacy_exit_phase",
  "cli_mode",
  "cli_profile",
  "cli_permission_mode",
  "cli_session_mode",
  "cli_turn_latency",
  "cli_exit",
  "recovery_failure",
  "recovery_rule_continue",
  "recovery_review_continue",
  "recovery_human_prompt",
  "recovery_human_continue",
  "recovery_human_revise",
  "recovery_review_error",
  "recovery_repeat_prompt",
  "recovery_review_latency",
  "client_surface",
  "client_version",
  "settings_language",
  "settings_desktop_layout",
  "settings_theme",
  "settings_theme_style",
  "settings_close_behavior",
  "settings_display_mode",
  "settings_status_bar_style",
  "settings_status_bar_items_count",
  "settings_check_updates",
  "settings_default_model",
  "settings_planner_model",
  "settings_subagent_model",
  "settings_subagent_effort",
  "settings_reasoning_language",
  "settings_provider_count",
  "settings_provider_access_count",
  "settings_provider_access",
  "settings_bot_enabled",
  "settings_bot_model",
  "settings_bot_tool_approval",
  "settings_bot_allowlist",
  "settings_bot_allow_all",
  "settings_bot_qq_enabled",
  "settings_bot_feishu_enabled",
  "settings_bot_weixin_enabled",
  "settings_bot_connection_count",
  "settings_bot_connection_provider",
  "settings_bot_connection_enabled",
  "settings_bot_connection_status",
  "settings_bot_connection_model",
  "settings_bot_connection_approval",
] as const;

type MetricSignal = (typeof METRIC_SIGNALS)[number];

const METRIC_SIGNAL_SET: ReadonlySet<string> = new Set(METRIC_SIGNALS);

const KnownMetricCounter = z.object({
  signal: z.enum(METRIC_SIGNALS),
  bucket: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9_]+$/),
  count: z.number().int().min(1).max(1_000_000),
});

const UnknownMetricCounter = z
  .object({
    signal: z
      .string()
      .min(1)
      .max(96)
      .refine((signal) => !METRIC_SIGNAL_SET.has(signal)),
  })
  .passthrough()
  .transform(() => null);

export const Metrics = z.object({
  version: z.string().min(1).max(64),
  os: z.string().min(1).max(32),
  arch: z.string().max(32).optional(),
  osBuild: z.number().int().min(0).max(1_000_000).optional(),
  osRevision: z.number().int().min(0).max(1_000_000).optional(),
  channel: z.string().max(32).optional(),
  distroId: z.string().max(64).optional(),
  distroVersion: z.string().max(64).optional(),
  kernelVersion: z.string().max(128).optional(),
  sessionType: z.enum(["wayland", "x11", "remote", "unknown"]).optional(),
  runtimeEngine: z.enum(["webview2", "webkitgtk", "unknown"]).optional(),
  runtimeVersion: z.string().max(128).optional(),
  gpuMode: z.enum(["enabled", "disabled", "always", "on_demand", "unknown"]).optional(),
  surface: ClientSurface.default("desktop"),
  counters: z
    .array(z.union([KnownMetricCounter, UnknownMetricCounter]))
    .min(1)
    .max(128)
    .transform((counters) =>
      counters.filter(
        (counter): counter is z.infer<typeof KnownMetricCounter> & { signal: MetricSignal } => counter !== null,
      ),
    ),
});
