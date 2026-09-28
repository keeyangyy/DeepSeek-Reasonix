// Group detail, admin, and community moderation handlers.
import { renderUsers, renderAudit, type AuditRow, type UserRow } from "./admin";
import { atLeast, logAction, sameOrigin, type Role, type User } from "./auth";
import { renderCommunity } from "./community";
import {
  acquireFirebaseGroupLease,
  crashStorageMode,
  firebaseGroupState,
  releaseFirebaseGroupLease,
  renewFirebaseGroupLease,
  type FirebaseGroupLease,
} from "./crash_delivery";
import { effectiveGroupSeverity } from "./diagnostics_v2";
import type { Env } from "./env";
import { LATEST_SAMPLES_PER_GROUP } from "./events";
import { archiveFirebaseGroupForAdmin } from "./firebase_lifecycle";
import { firebaseMeta, firebaseSamples, loadFirebaseGroupMeta } from "./firebase_crash_view";
import { readFirebaseCrashGroup, writeFirebaseGroupMeta } from "./firebase_rtdb";
import { renderGroup, type Group, type ReportSample } from "./group";
import { loadD1GroupReports, loadGroupDiagnostics } from "./group_queries";
import { GroupAction, UserAction, formObject, storageUnavailable } from "./handlers";
import { EventRepo } from "./registry/db/events";
import { PackageRepo } from "./registry/db/packages";
import type { Bindings as RegistryBindings } from "./registry/env";
import { html, redirect } from "./shell";
import { statsQueryObserver } from "./stats_timing";

export async function handleGroup(env: Env, fingerprint: string, user: User): Promise<Response> {
  const group = await env.DB.prepare("SELECT * FROM groups WHERE fingerprint = ?1").bind(fingerprint).first<Group>();
  if (!group) return new Response("not found", { status: 404 });
  group.severity = effectiveGroupSeverity(group);
  const state = crashStorageMode(env) === "d1" ? null : await firebaseGroupState(env, fingerprint);
  let reports: ReportSample[] = [], samplesUnavailable = false;
  if (crashStorageMode(env) === "firebase") {
    if (state?.sample_state === "archived") {
      reports = [];
    } else {
      try {
        const stored = await readFirebaseCrashGroup(env, fingerprint);
        reports = firebaseSamples(stored?.samples);
      } catch (error) {
        return storageUnavailable("firebase group detail", error);
      }
    }
  } else {
    const loaded = await loadD1GroupReports(env, fingerprint, LATEST_SAMPLES_PER_GROUP, statsQueryObserver("/stats/group"));
    reports = loaded.reports;
    samplesUnavailable = loaded.unavailable;
  }
  const loadedDiagnostics = await loadGroupDiagnostics(env, fingerprint, statsQueryObserver("/stats/group"));
  return html(renderGroup(
    group, reports, user, loadedDiagnostics.summary,
    state ? { state: state.sample_state, epoch: Number(state.sample_epoch) } : undefined,
    { samplesUnavailable, diagnosticsUnavailable: loadedDiagnostics.unavailable },
  ));
}

async function syncFirebaseGroupMetaLocked(
  env: Env,
  fingerprint: string,
  lease?: FirebaseGroupLease,
): Promise<void> {
  if (crashStorageMode(env) === "d1") return;
  if (!lease) throw new Error("firebase crash group lease is missing");
  const [group, state] = await Promise.all([
    loadFirebaseGroupMeta(env, fingerprint),
    firebaseGroupState(env, fingerprint),
  ]);
  if (!group || !state) return;
  if (state.sample_state === "archived") return;
  await writeFirebaseGroupMeta(
    env, fingerprint, firebaseMeta(group), lease.generation, Number(state.sample_epoch),
    state.sample_state, () => renewFirebaseGroupLease(env, fingerprint, lease),
  );
}

async function withFirebaseGroupLease<T>(
  env: Env,
  fingerprint: string,
  operation: (lease?: FirebaseGroupLease) => Promise<T>,
): Promise<T> {
  if (crashStorageMode(env) === "d1") return operation();
  const lease = await acquireFirebaseGroupLease(env, fingerprint);
  if (!lease) throw new Error("firebase crash group is busy");
  try {
    return await operation(lease);
  } finally {
    await releaseFirebaseGroupLease(env, fingerprint, lease).catch((error) => {
      console.error("firebase crash group lease release failed", error);
    });
  }
}

export async function handleGroupAction(request: Request, env: Env, admin: User, fingerprint: string): Promise<Response> {
  if (!sameOrigin(request)) return new Response("forbidden", { status: 403 });
  const parsed = GroupAction.safeParse(await formObject(request));
  if (!parsed.success) return redirect(`/stats/group/${fingerprint}`);
  const a = parsed.data;

  if (a.action === "delete") {
    try {
      if (crashStorageMode(env) !== "d1") {
        await archiveFirebaseGroupForAdmin(env, fingerprint);
      } else {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM reports WHERE fingerprint = ?1").bind(fingerprint),
          env.DB.prepare("DELETE FROM report_daily WHERE fingerprint = ?1").bind(fingerprint),
          env.DB.prepare("DELETE FROM report_installations WHERE fingerprint = ?1").bind(fingerprint),
          env.DB.prepare("DELETE FROM report_event_dimensions WHERE fingerprint = ?1").bind(fingerprint),
          env.DB.prepare("DELETE FROM firebase_crash_outbox WHERE fingerprint = ?1").bind(fingerprint),
          env.DB.prepare("DELETE FROM groups WHERE fingerprint = ?1").bind(fingerprint),
        ]);
      }
    } catch (error) {
      return storageUnavailable("firebase group deletion", error);
    }
    await logAction(env, admin, "delete_group", fingerprint.slice(0, 8));
    return redirect("/stats");
  }
  if (a.action === "status") {
    const status = a.status ?? "open";
    try {
      await withFirebaseGroupLease(env, fingerprint, async (lease) => {
        await env.DB.prepare(
          "UPDATE groups SET status = ?1, resolved_at = CASE WHEN ?1 = 'resolved' THEN ?3 ELSE resolved_at END WHERE fingerprint = ?2",
        ).bind(status, fingerprint, new Date().toISOString()).run();
        await syncFirebaseGroupMetaLocked(env, fingerprint, lease);
      });
    } catch (error) {
      return storageUnavailable("firebase group metadata", error);
    }
    await logAction(env, admin, "set_status", fingerprint.slice(0, 8), status);
    return redirect(`/stats/group/${fingerprint}`);
  }
  if (a.action === "resolution") {
    await env.DB.prepare("UPDATE groups SET resolved_in = ?1 WHERE fingerprint = ?2")
      .bind(a.resolvedIn ?? "", fingerprint)
      .run();
    await logAction(env, admin, "set_resolved_in", fingerprint.slice(0, 8), a.resolvedIn ?? "");
    return redirect(`/stats/group/${fingerprint}`);
  }
  if (a.action === "severity") {
    const severity = a.severity ?? "medium";
    try {
      await withFirebaseGroupLease(env, fingerprint, async (lease) => {
        await env.DB.prepare("UPDATE groups SET severity = ?1 WHERE fingerprint = ?2")
          .bind(severity, fingerprint)
          .run();
        await syncFirebaseGroupMetaLocked(env, fingerprint, lease);
      });
    } catch (error) {
      return storageUnavailable("firebase group metadata", error);
    }
    await logAction(env, admin, "set_severity", fingerprint.slice(0, 8), severity);
    return redirect(`/stats/group/${fingerprint}`);
  }
  await env.DB.prepare("UPDATE groups SET note = ?1 WHERE fingerprint = ?2").bind(a.note ?? "", fingerprint).run();
  await logAction(env, admin, "set_note", fingerprint.slice(0, 8));
  return redirect(`/stats/group/${fingerprint}`);
}

export async function handleAdminUsers(request: Request, env: Env, admin: User): Promise<Response> {
  if (!sameOrigin(request)) return new Response("forbidden", { status: 403 });
  const parsed = UserAction.safeParse(await formObject(request));
  if (!parsed.success) return redirect("/admin");
  const a = parsed.data;
  if (a.userId === admin.id) return redirect("/admin");

  const target = await env.DB.prepare("SELECT email, role FROM access WHERE id = ?1")
    .bind(a.userId)
    .first<{ email: string; role: Role }>();
  if (!target) return redirect("/admin");

  if (a.action === "delete") {
    await env.DB.prepare("DELETE FROM access WHERE id = ?1").bind(a.userId).run();
    await logAction(env, admin, "delete_user", target.email);
    return redirect("/admin");
  }

  const role: Role = a.role ?? "pending";
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE access SET role = ?1, approved_at = ?2, approved_by = ?3 WHERE id = ?4")
    .bind(role, role === "pending" ? null : now, admin.email, a.userId)
    .run();
  await logAction(env, admin, "set_role", target.email, `${target.role} → ${role}`);
  return redirect("/admin");
}

export async function handleAdminList(env: Env, admin: User): Promise<Response> {
  const users = await env.DB.prepare(
    "SELECT id, email, role, created_at, approved_at FROM access ORDER BY (role = 'pending') DESC, created_at DESC",
  ).all<UserRow>();
  return html(renderUsers(admin, users.results));
}

export async function handleAdminAudit(env: Env, admin: User): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT at, actor_email, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 200",
  ).all<AuditRow>();
  return html(renderAudit(admin, rows.results));
}

export function requireViewer(user: User | null, login: string): Response | null {
  if (!user) return redirect(login);
  if (!atLeast(user.role, "viewer")) return redirect("/account");
  return null;
}

// The folded registry API runs against its own database and resolves identity
// itself; hand it the second binding plus the account/site origins it expects.
export function registryBindings(env: Env): RegistryBindings {
  return {
    DB: env.REGISTRY_DB,
    WRITE_LIMITER: env.WRITE_LIMITER,
    ACCOUNTS_ORIGIN: env.ID_ORIGIN ?? "https://id.reasonix.io",
    APP_ORIGIN: env.APP_ORIGIN ?? "https://reasonix.io",
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? "https://reasonix.io,https://www.reasonix.io",
  };
}

export function communityStatus(url: URL): string {
  const s = url.searchParams.get("status") ?? "pending";
  return ["pending", "active", "hidden", "rejected"].includes(s) ? s : "pending";
}

export async function handleCommunityList(env: Env, admin: User, status: string): Promise<Response> {
  const rows = await new PackageRepo(env.REGISTRY_DB).listByStatus(status, 200);
  return html(renderCommunity(admin, rows, status));
}

export async function handleCommunityAction(
  request: Request,
  env: Env,
  admin: User,
  handle: string,
  name: string,
  action: string,
): Promise<Response> {
  if (!sameOrigin(request)) return new Response("forbidden", { status: 403 });
  const form = await formObject(request);
  const backStatus = ["pending", "active", "hidden", "rejected"].includes(form.status) ? form.status : "pending";
  const back = redirect(`/community?status=${backStatus}`);
  const slug = `${handle}/${name}`;
  const repo = new PackageRepo(env.REGISTRY_DB);
  const now = new Date().toISOString();

  if (action === "verify" || action === "unverify") {
    await repo.setVerified(slug, action === "verify", now);
    await logAction(env, admin, `pkg_${action}`, slug);
    return back;
  }
  if (action === "approve") {
    const expectedStatus = ["pending", "hidden", "rejected"].includes(form.expectedStatus)
      ? form.expectedStatus
      : "";
    if (!form.expectedVersion || !form.expectedUpdatedAt || !expectedStatus) {
      return new Response("Package review revision is missing. Refresh the review page and try again.", {
        status: 409,
      });
    }
    const row = await repo.setStatusIfCurrent(
      slug,
      "active",
      form.expectedVersion,
      form.expectedUpdatedAt,
      expectedStatus,
      now,
    );
    if (!row) {
      return new Response("Package changed since it was reviewed. Refresh and review the latest version.", {
        status: 409,
      });
    }
    // Emit the publish event only after the reviewed revision becomes public.
    await new EventRepo(env.REGISTRY_DB).log({
      type: "publish",
      packageId: row.id,
      actorHandle: row.scope_handle,
      summary: `published ${row.slug}@${row.latest_version}`,
      now,
    });
    await logAction(env, admin, "pkg_approve", slug);
    return back;
  }
  await repo.setStatus(slug, action === "reject" ? "rejected" : "hidden", now);
  await logAction(env, admin, `pkg_${action}`, slug);
  return back;
}
