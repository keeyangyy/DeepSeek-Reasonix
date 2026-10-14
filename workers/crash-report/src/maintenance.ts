// Scheduled maintenance: retention purge and the ingest sentinel.
import { crashStorageMode } from "./crash_delivery";
import type { Env } from "./env";
import { FIREBASE_OUTBOX_WARNING, firebaseStorageSummary } from "./firebase_lifecycle";
import { ensureCLITelemetrySchema } from "./telemetry";

// Time-series retention, run by the daily cron trigger. Every dashboard query
// against the per-install tables reads at most the current window (-29 day),
// while the aggregate `metrics` table also serves the 30d view's
// previous-window delta (back to -59 day), so it keeps a doubled horizon.
// `reports`/`groups` are excluded on purpose: they are the triage queue and
// the regression baseline, are not date-partitioned, and their growth is
// already bounded by per-group sampling. Without this purge the database
// grows until D1's size cap, at which point every ingest write starts
// throwing (all of /v1/ping, /v1/metrics and /v1/report 500 while reads keep
// working — exactly the 2026-07-03 stats blackout).
const RETENTION = [
  { table: "report_daily", keepDays: 30 },
  { table: "report_installations", keepDays: 30 },
  { table: "report_event_dimensions", keepDays: 30 },
  { table: "pings", keepDays: 30 },
  { table: "metrics", keepDays: 60 },
  { table: "cli_pings", keepDays: 30 },
  { table: "cli_metrics", keepDays: 60 },
] as const;
// Deletes run in rowid chunks so a run never holds one giant transaction.
// Steady state is one expired day per table; the chunk cap is a backstop that
// still drains ~2M rows per table per run after an ingest outage or backlog.
const RETENTION_CHUNK_ROWS = 10_000;
const RETENTION_MAX_CHUNKS = 200;

// Must match the sentinel entry in wrangler.toml [triggers] exactly — the
// scheduled handler dispatches on controller.cron; every other trigger
// (the retention cron, manual runs) falls through to the purge.
export const SENTINEL_CRON = "17 1,7,13,19 * * *";
// Ingest sentinel. The 2026-07-03 blackout went unnoticed for ten days because
// clients swallow ping failures by design and nothing watched the write path.
// Four times a day (hours chosen so the UTC day always has >1h of traffic;
// ~14k DAU means a healthy hour is never empty) this probes the two failure
// shapes independently:
//   1. canary write into `pings` (immediately deleted) — catches writes
//      throwing, e.g. the D1 size cap, regardless of traffic;
//   2. today's real ping and open totals compared with the previous run —
//      catches ingest dying upstream of the worker (edge blocking, client
//      regression) even after the UTC day already has traffic.
// Alerts go to the optional ALERT_WEBHOOK secret; without it they still land
// in the worker logs. While broken this fires at most 4 alerts/day.
const CANARY_INSTALL_ID = "ffffffffffffffffffffffffffffffff";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendAlert(env: Env, text: string): Promise<void> {
  if (!env.ALERT_WEBHOOK) return;
  try {
    const webhook = new URL(env.ALERT_WEBHOOK);
    const feishu = webhook.hostname === "open.feishu.cn" || webhook.hostname === "open.larksuite.com";
    const body = feishu ? { msg_type: "text", content: { text } } : { text };
    const res = await fetch(webhook.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`alert webhook responded ${res.status}`);
  } catch (err) {
    console.error("alert webhook unreachable", err);
  }
}

export async function runIngestSentinel(env: Env): Promise<void> {
  const problems: string[] = [];
  if (crashStorageMode(env) !== "d1") {
    try {
      const storage = await firebaseStorageSummary(env);
      if (storage.reservedBytes >= storage.budgetBytes * 0.8) {
        problems.push(`Firebase reserved storage is ${Math.round(storage.reservedBytes / 1048576)} MiB`);
      }
      if (storage.stuckArchiving > 0) problems.push(`${storage.stuckArchiving} Firebase archives are stuck`);
      if (storage.outboxCount >= FIREBASE_OUTBOX_WARNING) {
        problems.push(`Firebase outbox contains ${storage.outboxCount} rows`);
      }
    } catch (err) {
      problems.push(`Firebase storage sentinel failed: ${errText(err)}`);
    }
  }
  try {
    await env.DB.prepare(
      `INSERT INTO pings (date, install_id, version, os, arch, opens)
       VALUES (date('now'), ?1, 'canary', 'canary', 'canary', 0)
       ON CONFLICT (date, install_id) DO NOTHING`,
    )
      .bind(CANARY_INSTALL_ID)
      .run();
    // Also removes any leftover canary from a run that died mid-way.
    await env.DB.prepare("DELETE FROM pings WHERE install_id = ?1").bind(CANARY_INSTALL_ID).run();
  } catch (err) {
    problems.push(`canary write failed: ${errText(err)}`);
  }
  try {
    // Auto-create the one-row checkpoint so existing databases do not need a
    // manual migration before this worker version is deployed.
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS ingest_sentinel_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         day TEXT NOT NULL,
         ping_count INTEGER NOT NULL,
         open_count INTEGER NOT NULL,
         checked_at TEXT NOT NULL
       )`,
    ).run();
    const row = await env.DB.prepare(
      `SELECT date('now') AS day,
              COUNT(*) AS ping_count,
              COALESCE(SUM(opens), 0) AS open_count
       FROM pings
       WHERE date = date('now') AND install_id <> ?1`,
    )
      .bind(CANARY_INSTALL_ID)
      .first<{ day: string; ping_count: number; open_count: number }>();
    const day = row?.day ?? "";
    const pingCount = Number(row?.ping_count ?? 0);
    const openCount = Number(row?.open_count ?? 0);
    const previous = await env.DB.prepare(
      "SELECT day, ping_count, open_count, checked_at FROM ingest_sentinel_state WHERE id = 1",
    ).first<{ day: string; ping_count: number; open_count: number; checked_at: string }>();
    if (!pingCount) {
      problems.push("no launch pings recorded today (UTC)");
    } else if (
      previous?.day === day &&
      pingCount <= Number(previous.ping_count) &&
      openCount <= Number(previous.open_count)
    ) {
      problems.push(
        `launch ping totals unchanged since ${previous.checked_at} UTC (${pingCount} install rows, ${openCount} opens)`,
      );
    }
    await env.DB.prepare(
      `INSERT INTO ingest_sentinel_state (id, day, ping_count, open_count, checked_at)
       VALUES (1, ?1, ?2, ?3, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         day = ?1, ping_count = ?2, open_count = ?3, checked_at = datetime('now')`,
    )
      .bind(day, pingCount, openCount)
      .run();
  } catch (err) {
    problems.push(`ping progress check failed: ${errText(err)}`);
  }
  if (!problems.length) return;
  const message = `crash.reasonix.io ingest sentinel: ${problems.join("; ")} — https://crash.reasonix.io/stats`;
  console.error(message);
  await sendAlert(env, message);
}

export async function purgeExpiredStatsRows(env: Env): Promise<void> {
  try {
    await ensureCLITelemetrySchema(env);
  } catch (err) {
    console.error("retention: CLI telemetry schema unavailable", err);
  }
  for (const { table, keepDays } of RETENTION) {
    // Keep exactly the newest `keepDays` dates: today plus keepDays-1 back,
    // matching the `date >= date('now', '-{keepDays-1} day')` reads.
    const cutoff = `-${keepDays - 1} day`;
    let purged = 0;
    try {
      for (let i = 0; i < RETENTION_MAX_CHUNKS; i++) {
        const res = await env.DB.prepare(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT rowid FROM ${table} WHERE date < date('now', ?1) LIMIT ${RETENTION_CHUNK_ROWS}
           )`,
        )
          .bind(cutoff)
          .run();
        const changes = res.meta.changes ?? 0;
        purged += changes;
        if (changes < RETENTION_CHUNK_ROWS) break;
      }
      console.log(`retention: purged ${purged} rows from ${table} (keep ${keepDays}d)`);
    } catch (err) {
      // One broken table must not stop the others; the cron retries tomorrow.
      console.error(`retention: purge failed for ${table} after ${purged} rows`, err);
    }
  }
}
