// Ingest + dashboard for desktop crash/feedback/performance reports and the
// anonymous launch ping. Frontend reports are user-initiated; native fatal and
// lifecycle reports are sent on the next launch under the same opt-out desktop
// telemetry gate as pings.
import { atLeast, currentUser, loginUrl, sharedLogout, type User } from "./auth";
import { renderAccount } from "./auth_pages";
import { crashStorageMode, purgeFirebaseDeliveryState } from "./crash_delivery";
import {
  cliReleaseChannel,
  desktopReleaseChannel,
  handleCLIRelease,
  handleDesktopReleaseManifest,
  handleReleaseGatewayRequest,
} from "./desktop_release";
import type { Env } from "./env";
import { drainFirebaseCrashOutbox } from "./events";
import { runFirebaseCrashLifecycle } from "./firebase_lifecycle";
import {
  communityStatus,
  handleAdminAudit,
  handleAdminList,
  handleAdminUsers,
  handleCommunityAction,
  handleCommunityList,
  handleGroup,
  handleGroupAction,
  registryBindings,
  requireViewer,
} from "./groups";
import { handleMetrics, handlePing, handleReport } from "./handlers";
import { purgeExpiredStatsRows, runIngestSentinel, SENTINEL_CRON } from "./maintenance";
import { groupFingerprintFromPath } from "./normalize";
import registryApp from "./registry/app";
import { html, redirect } from "./shell";
import type { StatsModule } from "./stats";
import { handleStats } from "./versions";

export { Report } from "./report_schema";
export { diagnosticWindowWhere, effectiveGroupSeverity, isDevelopmentGroup } from "./diagnostics_v2";
export {
  CLI_TELEMETRY_SCHEMA_SQL,
  Metrics,
  Ping,
  ensureCLITelemetrySchema,
  telemetryTableNames,
} from "./telemetry";
export {
  groupFingerprintFromPath,
  isDevelopmentReport,
  isKnownNonCrashDiagnostic,
  maxSeverity,
  namespaceReportFingerprint,
  nativeWebRuntimeFingerprintBasis,
  normalizeForFingerprint,
  severityForReport,
} from "./normalize";
export { newestReleaseVersion } from "./versions";
export { drainFirebaseCrashOutbox } from "./events";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const desktopRelease = desktopReleaseChannel(path);
    if (desktopRelease) {
      return handleReleaseGatewayRequest(method, () => handleDesktopReleaseManifest(desktopRelease));
    }
    const cliRelease = cliReleaseChannel(path);
    if (cliRelease) {
      return handleReleaseGatewayRequest(method, () => handleCLIRelease(cliRelease));
    }

    if (path === "/v1/report" && method === "POST") return handleReport(request, env);
    if (path === "/v1/ping" && method === "POST") return handlePing(request, env);
    if (path === "/v1/metrics" && method === "POST") return handleMetrics(request, env);

    // Skill/MCP registry API — the folded Hono app handles its own auth, CORS
    // and rate limiting against the registry database (public reads + publish,
    // plus the JSON /v1/admin the site's moderation panel calls).
    if (path.startsWith("/v1/packages") || path === "/v1/activity" || path.startsWith("/v1/admin")) {
      return registryApp.fetch(request, registryBindings(env));
    }

    const login = loginUrl(env, request);

    // Authentication moved to id.reasonix.io; these paths just bounce there.
    if ((path === "/login" || path === "/register") && method === "GET") return redirect(login);
    if (path === "/logout" && method === "POST") return redirect(login, await sharedLogout(request, env));

    const user = await currentUser(request, env);

    if (path === "/") return redirect(user ? (atLeast(user.role, "viewer") ? "/stats" : "/account") : login);

    if (path === "/account" && method === "GET") return user ? html(renderAccount(user)) : redirect(login);

    const groupFingerprint = groupFingerprintFromPath(path);
    const statsModuleMatch = path.match(/^\/stats\/(diagnostics|usage|preferences|health)$/);
    if ((path === "/stats" || statsModuleMatch) && method === "GET")
      return requireViewer(user, login) ?? handleStats(request, env, user as User, (statsModuleMatch?.[1] as StatsModule | undefined) ?? "usage");
    if (groupFingerprint && method === "GET") return requireViewer(user, login) ?? handleGroup(env, groupFingerprint, user as User);
    if (groupFingerprint && method === "POST") {
      if (user?.role !== "admin") return new Response("forbidden", { status: 403 });
      return handleGroupAction(request, env, user, groupFingerprint);
    }

    if (path === "/admin" && method === "GET") {
      if (!user) return redirect(login);
      return user.role === "admin" ? handleAdminList(env, user) : redirect("/account");
    }
    if (path === "/admin/audit" && method === "GET") {
      if (!user) return redirect(login);
      return user.role === "admin" ? handleAdminAudit(env, user) : redirect("/account");
    }
    if (path === "/admin/users" && method === "POST") {
      if (user?.role !== "admin") return new Response("forbidden", { status: 403 });
      return handleAdminUsers(request, env, user);
    }

    if (path === "/community" && method === "GET") {
      if (!user) return redirect(login);
      return user.role === "admin" ? handleCommunityList(env, user, communityStatus(url)) : redirect("/account");
    }
    const pkgActionMatch = path.match(/^\/community\/([^/]+)\/([^/]+)\/(approve|reject|hide|verify|unverify)$/);
    if (pkgActionMatch && method === "POST") {
      if (user?.role !== "admin") return new Response("forbidden", { status: 403 });
      return handleCommunityAction(request, env, user, pkgActionMatch[1], pkgActionMatch[2], pkgActionMatch[3]);
    }

    if (
      path === "/v1/report" ||
      path === "/v1/ping" ||
      path === "/v1/metrics" ||
      path === "/login" ||
      path === "/register" ||
      path === "/logout" ||
      path === "/account" ||
      path.startsWith("/stats") ||
      path.startsWith("/admin") ||
      path.startsWith("/community")
    ) {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === SENTINEL_CRON) {
      ctx.waitUntil(Promise.all([
        runIngestSentinel(env),
        drainFirebaseCrashOutbox(env),
      ]).then(() => undefined));
      return;
    }
    ctx.waitUntil(Promise.all([
      purgeExpiredStatsRows(env),
      crashStorageMode(env) === "d1" ? Promise.resolve() : purgeFirebaseDeliveryState(env),
      drainFirebaseCrashOutbox(env),
      crashStorageMode(env) === "d1" ? Promise.resolve() : runFirebaseCrashLifecycle(env),
    ]).then(() => undefined));
  },
};
