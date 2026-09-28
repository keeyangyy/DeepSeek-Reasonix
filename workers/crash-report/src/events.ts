// Crash event preparation and projection into D1 + Firebase.
import { crashStorageMode, firebaseProjectionExists, projectionCompletionStatements } from "./crash_delivery";
import { reportAggregateStatements } from "./diagnostics_v2";
import { drainFirebaseCrashOutbox as drainFirebaseOutbox, type StoredCrashEvent } from "./firebase_delivery";
import type { Env } from "./env";
import {
  basenameOnly,
  crashTitle,
  hasStructuredCrashFields,
  isDevelopmentReport,
  namespaceReportFingerprint,
  nativeWebRuntimeFingerprintBasis,
  normalizeForFingerprint,
  normalizedWebRuntime,
  scrubSensitiveText,
  severityForReport,
} from "./normalize";
import type { ReportPayload } from "./report_schema";

export const LATEST_SAMPLES_PER_GROUP = 5;
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function prepareCrashEvent(r: ReportPayload, keepD1Sample: boolean): Promise<StoredCrashEvent> {
  const message = scrubSensitiveText(r.message);
  const errorMessage = scrubSensitiveText(r.errorMessage ?? "");
  const stack = scrubSensitiveText(r.stack ?? "");
  const componentStack = scrubSensitiveText(r.componentStack ?? "");
  const topFrame = scrubSensitiveText(r.topFrame ?? "");
  const fingerprintHint = scrubSensitiveText(r.fingerprintHint ?? "");
  const view = scrubSensitiveText(r.view ?? "");
  const breadcrumbs = (r.breadcrumbs ?? []).map((breadcrumb) => ({
    ...breadcrumb,
    msg: breadcrumb.msg ? scrubSensitiveText(breadcrumb.msg) : breadcrumb.msg,
  }));
  const webRuntime = normalizedWebRuntime(r);
  const webview2 = r.webview2
    ? {
        ...r.webview2,
        processDescription: scrubSensitiveText(r.webview2.processDescription ?? "").slice(0, 255),
        failureSourceModule: basenameOnly(r.webview2.failureSourceModule),
      }
    : undefined;
  const report: ReportPayload = {
    ...r,
    eventId: r.eventId ?? crypto.randomUUID().replaceAll("-", ""),
    message,
    errorMessage,
    stack,
    componentStack,
    topFrame,
    fingerprintHint,
    view,
    breadcrumbs,
    webRuntime,
    webview2,
  };
  const fingerprintBasis = (
    report.source === "web.runtime.native" || report.source === "webview2.process.native"
  ) && webRuntime
    ? nativeWebRuntimeFingerprintBasis(webRuntime)
    : hasStructuredCrashFields(report)
      ? normalizeForFingerprint({
        kind: report.kind,
        message,
        source: report.source,
        label: report.label,
        errorType: report.errorType,
        errorMessage,
        topFrame,
        fingerprintHint,
      })
      : normalizeForFingerprint(report.kind, message);
  const severityInput = {
    kind: report.kind,
    version: report.version,
    source: report.source ?? "legacy",
    label: report.label ?? "",
    errorType: report.errorType ?? "",
    errorMessage,
    topFrame,
    channel: report.channel ?? "",
    recovery: webRuntime?.recovery,
  };
  const development = isDevelopmentReport(severityInput);
  return {
    eventId: report.eventId!,
    fingerprint: namespaceReportFingerprint(await sha256Hex(fingerprintBasis), development),
    receivedAt: new Date().toISOString(),
    keepD1Sample,
    report,
  };
}

export async function projectCrashEvent(env: Env, event: StoredCrashEvent): Promise<void> {
  const firebaseDelivery = crashStorageMode(env) !== "d1";
  if (firebaseDelivery && await firebaseProjectionExists(env, event.eventId)) {
    await env.DB.prepare(
      "UPDATE firebase_crash_outbox SET state = 'projected', updated_at = ?2 WHERE event_id = ?1",
    ).bind(event.eventId, new Date().toISOString()).run();
    return;
  }
  const r = event.report;
  const webRuntime = normalizedWebRuntime(r);
  const webview2 = r.webview2;
  const message = r.message;
  const errorMessage = r.errorMessage ?? "";
  const topFrame = r.topFrame ?? "";
  const source = r.source ?? "legacy";
  const label = r.label ?? "";
  const errorType = r.errorType ?? "";
  const buildCommit = r.buildCommit ?? "";
  const channel = r.channel ?? "";
  const severity = severityForReport({
    kind: r.kind,
    version: r.version,
    source,
    label,
    errorType,
    errorMessage,
    topFrame,
    channel,
    recovery: webRuntime?.recovery,
  });
  const prior = await env.DB.prepare("SELECT status FROM groups WHERE fingerprint = ?1")
    .bind(event.fingerprint)
    .first<{ status: string }>();
  const regressedAt = prior?.status === "resolved" ? event.receivedAt : "";
  const groupWrite = env.DB.prepare(
    `INSERT INTO groups (
       fingerprint, kind, count, first_seen, last_seen, first_version, last_version,
       status, title, source, label, error_type, top_frame, severity,
       last_os, last_arch, last_build_commit, last_channel, last_sample_at, regressed_at
     )
     VALUES (?1, ?2, 1, ?3, ?3, ?4, ?4, 'open', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?3, ?15)
     ON CONFLICT (fingerprint) DO UPDATE SET
       kind = CASE
         WHEN severity = 'critical' THEN kind
         WHEN (CASE ?10 WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) >
              (CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
           THEN ?2 ELSE kind END,
       count = count + 1, last_seen = ?3, last_version = ?4, title = ?5,
       source = ?6, label = ?7, error_type = ?8, top_frame = ?9,
       severity = CASE
         WHEN severity = 'critical' THEN severity
         WHEN (CASE ?10 WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) >
              (CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
           THEN ?10 ELSE severity END,
       last_os = ?11, last_arch = ?12, last_build_commit = ?13, last_channel = ?14,
       last_sample_at = ?3,
       status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
       regressed_at = CASE WHEN status = 'resolved' THEN ?3 ELSE regressed_at END`,
  ).bind(
    event.fingerprint, r.kind, event.receivedAt, r.version, crashTitle(message), source,
    label, errorType, topFrame, severity, r.os, r.arch, buildCommit, channel, regressedAt,
  );
  const statements: D1PreparedStatement[] = [groupWrite];
  if (event.keepD1Sample) {
    statements.push(env.DB.prepare(
      `INSERT INTO reports (
         fingerprint, kind, version, os, arch, message, device, created_at,
         source, label, error_type, error_message, top_frame, build_commit, channel,
         language, view, breadcrumbs, component_stack, stack, occurred_at, webview2, web_runtime
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
    ).bind(
      event.fingerprint, r.kind, r.version, r.os, r.arch, message,
      JSON.stringify(r.device ?? {}), event.receivedAt, source, label, errorType, errorMessage,
      topFrame, buildCommit, channel, r.language ?? "", r.view ?? "",
      JSON.stringify(r.breadcrumbs ?? []), r.componentStack ?? "", r.stack ?? "",
      r.occurredAt ?? "", webview2 ? JSON.stringify(webview2) : "",
      webRuntime ? JSON.stringify(webRuntime) : "",
    ));
  }
  statements.push(...reportAggregateStatements(env.DB, r, event.fingerprint, channel, webRuntime));
  if (event.keepD1Sample) {
    statements.push(env.DB.prepare(
      `DELETE FROM reports WHERE fingerprint = ?1 AND id NOT IN (
         SELECT id FROM (SELECT id FROM reports WHERE fingerprint = ?1 ORDER BY id ASC LIMIT 1)
         UNION
         SELECT id FROM (SELECT id FROM reports WHERE fingerprint = ?1 ORDER BY id DESC LIMIT ?2)
       )`,
    ).bind(event.fingerprint, LATEST_SAMPLES_PER_GROUP));
  }
  if (firebaseDelivery) {
    statements.push(...projectionCompletionStatements(
      env.DB, event.eventId, event.fingerprint, event.receivedAt,
    ));
  }
  await env.DB.batch(statements);
}

export async function drainFirebaseCrashOutbox(env: Env): Promise<void> {
  return drainFirebaseOutbox(env, projectCrashEvent);
}
