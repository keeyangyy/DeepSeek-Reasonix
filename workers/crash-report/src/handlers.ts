// HTTP ingest handlers and their request parsing helpers.
import { z } from "zod";
import {
  acquireFirebaseGroupLease,
  claimFirebaseCrash,
  crashStorageMode,
  enqueueFirebaseCrash,
  firebaseEventExists,
  firebaseStorageReady,
  reclaimUnusedFirebaseReservation,
  recordFirebaseRetry,
  releaseFirebaseGroupLease,
  reserveFirebaseGroup,
  type FirebaseGroupLease,
} from "./crash_delivery";
import type { Env } from "./env";
import { prepareCrashEvent, projectCrashEvent } from "./events";
import { deliverCrashEventToFirebase } from "./firebase_delivery";
import { Report } from "./report_schema";
import { Metrics, Ping, ensureCLITelemetrySchema, telemetryTableNames } from "./telemetry";

const MAX_BODY_BYTES = 96 * 1024;
async function readJSON(request: Request): Promise<unknown | Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!length || length > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
  try {
    return JSON.parse(await request.text());
  } catch {
    return new Response("bad request", { status: 400 });
  }
}

// Storage operations surface a deliberate 503 with a loud but credential-free
// log instead of an opaque worker exception, so clients retain retryable state.
export function storageUnavailable(op: string, err: unknown): Response {
  console.error(`${op}: storage unavailable`, err);
  return new Response("storage unavailable", { status: 503 });
}
export async function handleReport(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  if (!success) return new Response("rate limited", { status: 429 });

  const raw = await readJSON(request);
  if (raw instanceof Response) return raw;
  const parsed = Report.safeParse(raw);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  let mode;
  try {
    mode = crashStorageMode(env);
    if (!firebaseStorageReady(env)) throw new Error("firebase crash storage is not configured");
  } catch (err) {
    console.error("report: crash storage configuration failed", err);
    return new Response("storage unavailable", { status: 503 });
  }
  const event = await prepareCrashEvent(parsed.data, mode !== "firebase");
  if (mode !== "d1") {
    let lease: FirebaseGroupLease | null = null;
    try {
      if (await firebaseEventExists(env, event.eventId)) return new Response("ok", { status: 202 });
      if (await reserveFirebaseGroup(env, event.fingerprint, event.receivedAt) === "full") {
        return new Response("storage unavailable", { status: 503 });
      }
      const enqueued = await enqueueFirebaseCrash(
        env, event.eventId, event.fingerprint, JSON.stringify(event), event.receivedAt,
      );
      if (enqueued === "duplicate") return new Response("ok", { status: 202 });
      if (enqueued === "full") {
        await reclaimUnusedFirebaseReservation(env, event.fingerprint);
        return new Response("storage unavailable", { status: 503 });
      }
      lease = await acquireFirebaseGroupLease(env, event.fingerprint);
    } catch (err) {
      return storageUnavailable("report outbox", err);
    }
    if (!lease) return new Response("ok", { status: 202 });
    try {
      if (!await claimFirebaseCrash(env, event.eventId, new Date().toISOString())) {
        return new Response("ok", { status: 202 });
      }
      try {
        await projectCrashEvent(env, event);
      } catch (err) {
        console.error("report: buffered D1 projection failed", err);
        await recordFirebaseRetry(env, event.eventId, "queued", 0);
        return new Response("ok", { status: 202 });
      }
      await deliverCrashEventToFirebase(env, event, 0, lease);
      return new Response("ok", { status: 202 });
    } finally {
      await releaseFirebaseGroupLease(env, event.fingerprint, lease).catch((error) => {
        console.error("firebase crash group lease release failed", error);
      });
    }
  }
  try {
    await projectCrashEvent(env, event);
  } catch (err) {
    return storageUnavailable("report", err);
  }
  return new Response("ok", { status: 202 });
}

export async function handlePing(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.PING_LIMITER.limit({ key: ip });
  if (!success) return new Response("rate limited", { status: 429 });

  const raw = await readJSON(request);
  if (raw instanceof Response) return raw;
  const parsed = Ping.safeParse(raw);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  const p = parsed.data;
  const tables = telemetryTableNames(p.surface);

  try {
    if (p.surface === "cli") await ensureCLITelemetrySchema(env);
    await env.DB.prepare(
      `INSERT INTO ${tables.pings} (
         date, install_id, version, os, arch, os_version, os_build, os_revision, channel,
         distro_id, distro_version, kernel_version, session_type, runtime_engine, runtime_version, gpu_mode, opens
       )
       VALUES (date('now'), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1)
       ON CONFLICT (date, install_id) DO UPDATE SET
         opens = opens + 1, version = ?2, os_version = ?5, os_build = ?6, os_revision = ?7,
         channel = ?8, distro_id = ?9, distro_version = ?10, kernel_version = ?11,
         session_type = ?12, runtime_engine = ?13, runtime_version = ?14, gpu_mode = ?15`,
    )
      .bind(
        p.installId, p.version, p.os, p.arch, p.osVersion ?? "", p.osBuild ?? 0, p.osRevision ?? 0,
        p.channel ?? "", p.distroId ?? "", p.distroVersion ?? "", p.kernelVersion ?? "",
        p.sessionType ?? "", p.runtimeEngine ?? "", p.runtimeVersion ?? "", p.gpuMode ?? "",
      )
      .run();
  } catch (err) {
    return storageUnavailable("ping", err);
  }

  return new Response("ok", { status: 202 });
}

export async function handleMetrics(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.METRICS_LIMITER.limit({ key: ip });
  if (!success) return new Response("rate limited", { status: 429 });

  const raw = await readJSON(request);
  if (raw instanceof Response) return raw;
  const parsed = Metrics.safeParse(raw);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  const m = parsed.data;
  if (m.counters.length === 0) return new Response("ok", { status: 202 });
  const tables = telemetryTableNames(m.surface);

  try {
    if (m.surface === "cli") await ensureCLITelemetrySchema(env);
    const upsert = env.DB.prepare(
      `INSERT INTO ${tables.metrics} (date, version, os, signal, bucket, count)
       VALUES (date('now'), ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (date, version, os, signal, bucket) DO UPDATE SET
         count = count + ?5`,
    );
    await env.DB.batch(m.counters.map((c) => upsert.bind(m.version, m.os, c.signal, c.bucket, c.count)));
  } catch (err) {
    return storageUnavailable("metrics", err);
  }
  return new Response("ok", { status: 202 });
}

export const UserAction = z.object({
  action: z.enum(["role", "delete"]),
  userId: z.coerce.number().int().positive(),
  role: z.enum(["pending", "viewer", "admin"]).optional(),
});

export const GroupAction = z.object({
  action: z.enum(["status", "delete", "note", "resolution", "severity"]),
  status: z.enum(["open", "resolved", "ignored"]).optional(),
  note: z.string().max(500).optional(),
  resolvedIn: z.string().max(64).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export async function formObject(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form) out[k] = typeof v === "string" ? v : "";
  return out;
}
