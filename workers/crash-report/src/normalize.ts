// Crash message normalization, fingerprinting, and severity helpers.
import { z } from "zod";
import { DEVELOPMENT_FINGERPRINT_PREFIX } from "./diagnostics_v2";
import { WebRuntimeDiagnostic, type ReportPayload } from "./report_schema";

const GROUP_PATH_RE = /^\/stats\/group\/((?:dev:)?[0-9a-f]{64})$/;
type FingerprintInput = {
  kind: string;
  message: string;
  source?: string;
  label?: string;
  errorType?: string;
  errorMessage?: string;
  topFrame?: string;
  fingerprintHint?: string;
};

export function scrubSensitiveText(input: string): string {
  return input
    .replace(/([A-Z]:\\Users\\)[^/\\:\s"']+/gi, "$1_")
    .replace(/(\/(?:home|Users)\/)[^/\\:\s"']+/g, "$1_")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|secret|password|passwd|pwd|token)\b\s*[:=]\s*(?:Bearer\s+)?['"]?[^'"\s,;]+['"]?/gi,
      "$1=[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted-key]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[redacted-hex]")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[redacted-token]");
}

function normalizeStackFrame(frame: string): string {
  return frame
    .replace(/[A-Za-z]:\\[^\s)('"]+/g, "<path>")
    .replace(/\/(?:home|Users)\/[^\s)('"]+/g, "/<home>")
    .replace(/(?:wails|https?|file):\/\/[^\s)('"]+/g, "<url>")
    .replace(/0x[0-9a-fA-F]+/g, "<addr>")
    .replace(/:\d+(?::\d+)?/g, ":<n>");
}

function normalizeFingerprintText(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s)('"]+/g, "<path>")
    .replace(/(?:wails|https?|file):\/\/[^\s)('"]+/g, "<url>")
    .replace(/0x[0-9a-fA-F]+/g, "<addr>")
    .replace(/^build [0-9a-f]+$/gm, "build <commit>")
    .replace(/:\d+(?::\d+)?/g, ":<n>");
}

export function normalizeForFingerprint(inputOrKind: FingerprintInput | string, legacyMessage = ""): string {
  if (typeof inputOrKind === "string") {
    const head = legacyMessage.split("\n").slice(0, 12).join("\n");
    return inputOrKind + "\n" + normalizeFingerprintText(head);
  }
  const input = inputOrKind;
  const messageBasis = input.errorMessage || input.message;
  const head = messageBasis.split("\n").slice(0, 6).join("\n");
  return (
    input.kind +
    "\n" +
    (input.source || "legacy") +
    "\n" +
    (input.label || "") +
    "\n" +
    (input.errorType || "") +
    "\n" +
    normalizeStackFrame(input.topFrame || "") +
    "\n" +
    (input.fingerprintHint ? `${input.fingerprintHint}\n` : "") +
    normalizeFingerprintText(head)
  );
}

export function nativeWebRuntimeFingerprintBasis(input: {
  engine: string;
  kind: string;
  reason: string;
  exitCode?: number;
}): string {
  const kind = normalizeRuntimeBucket(input.engine, "kind", input.kind);
  const reason = normalizeRuntimeBucket(input.engine, "reason", input.reason);
  const normalizedExitCode = input.engine === "webview2" && kind === "render_process_unresponsive" && input.exitCode === 259 ? undefined : input.exitCode;
  const exitCode = normalizedExitCode === undefined ? "unknown" : String(normalizedExitCode);
  return [input.engine, kind, reason, exitCode].join("\n");
}

type NormalizedWebRuntime = z.infer<typeof WebRuntimeDiagnostic>;

export function basenameOnly(value: string | undefined): string {
  return (value ?? "").split(/[\\/]/).pop()?.slice(0, 255) ?? "";
}

function normalizeRuntimeBucket(engine: string, field: "kind" | "reason", input: string): string {
  const buckets = engine === "webview2"
    ? field === "kind"
      ? ["browser_process_exited", "render_process_exited", "render_process_unresponsive", "frame_render_process_exited", "utility_process_exited", "sandbox_helper_process_exited", "gpu_process_exited", "ppapi_plugin_process_exited", "ppapi_broker_process_exited", "unknown_process_exited", "unknown"]
      : ["unexpected", "unresponsive", "terminated", "crashed", "launch_failed", "out_of_memory", "profile_deleted", "normal_exit", "abnormal_exit", "integrity_failure", "unknown"]
    : field === "kind"
      ? ["web_process", "unknown"]
      : ["crashed", "out_of_memory", "terminated_by_api", "unknown"];
  const value = input.trim().toLowerCase();
  return buckets.includes(value) ? value : "unknown";
}

export function normalizedWebRuntime(r: ReportPayload): NormalizedWebRuntime | undefined {
  const input: NormalizedWebRuntime | undefined = r.webRuntime ?? (r.webview2
    ? {
        engine: "webview2",
        kind: r.webview2.kind,
        reason: r.webview2.reason,
        exitCode: r.webview2.exitCode,
        processDescription: r.webview2.processDescription,
        failureSourceModule: r.webview2.failureSourceModule,
        runtimeVersion: r.webview2.runtimeVersion,
        gpuMode: r.webview2.gpuDisabled ? "disabled" : "enabled",
        recovery: r.webview2.recovery,
      }
    : undefined);
  if (!input) return undefined;
  return {
    ...input,
    kind: normalizeRuntimeBucket(input.engine, "kind", input.kind),
    reason: normalizeRuntimeBucket(input.engine, "reason", input.reason),
    runtimeVersion: input.runtimeVersion.trim() || "unknown",
    exitCode: input.engine === "webview2" && normalizeRuntimeBucket(input.engine, "kind", input.kind) === "render_process_unresponsive" && input.exitCode === 259 ? undefined : input.exitCode,
    processDescription: scrubSensitiveText(input.processDescription ?? "").slice(0, 255),
    failureSourceModule: basenameOnly(input.failureSourceModule),
  };
}

export function hasStructuredCrashFields(r: ReportPayload): boolean {
  return Boolean(
    r.schemaVersion ||
      r.source ||
      r.label ||
      r.errorType ||
      r.errorMessage ||
      r.stack ||
      r.componentStack ||
      r.topFrame ||
      r.fingerprintHint ||
      r.buildCommit ||
      r.channel ||
      r.language ||
      r.view ||
      r.breadcrumbs?.length ||
      r.occurredAt,
  );
}

// One-line human summary for the dashboard list. Frontend reports are formatted
// "[label]\n\n<detail>", so a bare label alone is folded together with its detail.
export function crashTitle(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let head = lines[0] ?? "";
  if (/^\[[^\]]+\]$/.test(head) && lines[1]) head = `${head} ${lines[1]}`;
  return head.slice(0, 200);
}

type SeverityInput = {
  kind: string;
  version?: string;
  source: string;
  label: string;
  errorType: string;
  errorMessage: string;
  topFrame: string;
  channel?: string;
  recovery?: string;
};

const RESIZE_OBSERVER_NOTICE_RE = /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.?)$/;

export function isDevelopmentReport(input: SeverityInput): boolean {
  const channel = input.channel?.trim().toLowerCase();
  return channel === "dev" || channel === "test" || input.version?.trim().toLowerCase().startsWith("dev") === true;
}

export function namespaceReportFingerprint(hash: string, development: boolean): string {
  return development ? `${DEVELOPMENT_FINGERPRINT_PREFIX}${hash}` : hash;
}

export function groupFingerprintFromPath(path: string): string | null {
  return path.match(GROUP_PATH_RE)?.[1] ?? null;
}

export function isKnownNonCrashDiagnostic(input: SeverityInput): boolean {
  const message = input.errorMessage.trim();
  return (
    RESIZE_OBSERVER_NOTICE_RE.test(message) ||
    /Minified React error #520\b/.test(message) ||
    message.includes("additional File object is not a file on the disk")
  );
}

export function isOpaqueScriptErrorReport(input: SeverityInput): boolean {
  return (
    input.kind === "crash" &&
    input.source === "frontend.global" &&
    input.label === "window.error" &&
    input.errorType === "string" &&
    input.errorMessage.trim() === "Script error." &&
    input.topFrame.trim() === ""
  );
}

function severityForKind(kind: string): string {
  if (kind === "crash") return "high";
  if (kind === "performance") return "medium";
  if (kind === "bot") return "medium";
  if (kind === "exception") return "medium";
  return "low";
}

export function severityForReport(input: SeverityInput): string {
  if (isDevelopmentReport(input) || isOpaqueScriptErrorReport(input) || isKnownNonCrashDiagnostic(input)) return "low";
  if ((input.source === "web.runtime.native" || input.source === "webview2.process.native") && input.recovery === "reload_succeeded") return "low";
  if ((input.source === "web.runtime.native" || input.source === "webview2.process.native") && input.kind === "exception") return "high";
  return severityForKind(input.kind);
}

export function severityRank(severity: string): number {
  return ({ low: 1, medium: 2, high: 3, critical: 4 })[severity] ?? 0;
}

export function maxSeverity(current: string, incoming: string): string {
  return severityRank(incoming) > severityRank(current) ? incoming : current;
}
