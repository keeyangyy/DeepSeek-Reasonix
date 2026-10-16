import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { app, onUpdaterProgress } from "./bridge";
import type { UpdateInfo } from "./types";
import type { UpdateVersionList } from "./updateVersions";

// useUpdater drives the auto-update state machine shared by the top banner and the
// Settings panel. v1.20+ uses a single "update and restart" action that downloads,
// verifies, installs, and relaunches. There is no durable cross-restart pending
// state: failures leave the current version running and the user simply retries.

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; current: string }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; received: number; total: number; info?: UpdateInfo }
  | { kind: "verifying"; info?: UpdateInfo }
  | { kind: "authorizing"; info?: UpdateInfo }
  | { kind: "installing"; info?: UpdateInfo }
  | { kind: "relaunching"; info?: UpdateInfo }
  | { kind: "done" }
  | { kind: "error"; message: string; info?: UpdateInfo; disposition: UpdateErrorDisposition };

export type UpdateErrorDisposition = "retryable" | "recovery" | "manual";

export interface Updater {
  status: UpdateStatus;
  check: () => Promise<void>;
  /** Refresh an idle updater without superseding an active operation. */
  refresh: () => Promise<void>;
  /** Single-action update: download + verify + install + relaunch. */
  apply: (info: UpdateInfo) => void;
  /** The versions the update panel may offer, newest first (Settings list). */
  versions: UpdateVersionList | null;
  /** Load the version list without superseding an active operation. */
  listVersions: () => Promise<void>;
  /** Install one version the list offered — an older or pre-release build. */
  applyVersion: (version: string) => void;
  openDownload: () => void;
  /** Discard a stuck previous update transaction so the next install can proceed. */
  abandonPending: () => Promise<void>;
  reset: () => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function classifyUpdateError(message: string): UpdateErrorDisposition {
  const low = message.toLowerCase();
  if (/pending update already exists|could not safely finish the previous update|handoff backup|awaiting startup health|discard the previous update|previous update is still completing/.test(low)) {
    return "recovery";
  }
  if (/authorization failed|manual update required|pkexec|sudo apt install/.test(low)) {
    return "manual";
  }
  return "retryable";
}

function updateError(message: string, info?: UpdateInfo): UpdateStatus {
  return { kind: "error", message, info, disposition: classifyUpdateError(message) };
}

const UpdaterContext = createContext<Updater | null>(null);

type UpdaterOperationKind = "idle" | "checking" | "ready" | "applying" | "abandoning";

interface UpdaterOperation {
  epoch: number;
  requestId: string;
  channel: "" | "stable" | "preview";
  expectedVersion: string;
  kind: UpdaterOperationKind;
}

let updaterRequestSequence = 0;
const updaterRequestPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function nextUpdaterRequestId(epoch: number): string {
  updaterRequestSequence += 1;
  return `web-${updaterRequestPrefix}-${epoch}-${updaterRequestSequence}`;
}

function normalizedChannel(channel: string): "stable" | "preview" {
  return channel === "preview" ? "preview" : "stable";
}

function isBusyOperation(kind: UpdaterOperationKind): boolean {
  return kind === "checking" || kind === "applying" || kind === "abandoning";
}

function useUpdaterInternal(): Updater {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const operationRef = useRef<UpdaterOperation>({
    epoch: 0,
    requestId: "initial",
    channel: "",
    expectedVersion: "",
    kind: "idle",
  });

  const beginOperation = useCallback((
    channel: string,
    kind: UpdaterOperationKind,
    expectedVersion = "",
  ): UpdaterOperation => {
    const epoch = operationRef.current.epoch + 1;
    const next: UpdaterOperation = {
      epoch,
      requestId: nextUpdaterRequestId(epoch),
      channel: channel ? normalizedChannel(channel) : "",
      expectedVersion,
      kind,
    };
    operationRef.current = next;
    return next;
  }, []);

  const isCurrentOperation = useCallback((operation: UpdaterOperation): boolean => {
    const current = operationRef.current;
    return current.epoch === operation.epoch &&
      current.requestId === operation.requestId &&
      current.channel === operation.channel &&
      current.expectedVersion === operation.expectedVersion;
  }, []);

  const completeOperation = useCallback((operation: UpdaterOperation): void => {
    if (isCurrentOperation(operation)) {
      operationRef.current = { ...operationRef.current, kind: "ready" };
    }
  }, [isCurrentOperation]);

  // A single long-lived subscription advances the state machine through apply
  // phases. Channel and operation-kind checks prevent a superseded native call
  // from publishing into a newly selected channel.
  useEffect(() => {
    return onUpdaterProgress((p) => {
      const operation = operationRef.current;
      if (
        !p.requestId ||
        p.requestId !== operation.requestId ||
        !p.channel ||
        normalizedChannel(p.channel) !== operation.channel ||
        !p.version ||
        p.version !== operation.expectedVersion
      ) return;
      const accepted =
        operation.kind === "applying" &&
        (
          p.phase === "downloading" ||
          p.phase === "verifying" ||
          p.phase === "authorizing" ||
          p.phase === "installing" ||
          p.phase === "relaunching" ||
          p.phase === "done" ||
          p.phase === "error" ||
          // Tolerate legacy backend phases during the migration window.
          p.phase === "downloaded" ||
          p.phase === "recovering"
        );
      if (!accepted) return;
      if (p.phase === "done" || p.phase === "error") {
        operationRef.current = { ...operation, kind: "ready" };
      }
      setStatus((cur) => {
        const info = "info" in cur ? cur.info : undefined;
        if (info && normalizedChannel(info.channel) !== operation.channel) return cur;
        switch (p.phase) {
          case "downloading":
            // A picked version has no UpdateInfo, so these three advance on the
            // progress payload alone rather than short-circuiting on `info`.
            return { kind: "downloading", received: p.received, total: p.total, info };
          case "verifying":
            return { kind: "verifying", info };
          case "downloaded":
            // Intermediate cache-ready signal: keep showing verifying/installing
            // rather than a separate user action.
            return { kind: "installing", info };
          case "authorizing":
            return { kind: "authorizing", info };
          case "recovering":
          case "installing":
            return { kind: "installing", info };
          case "relaunching":
            return { kind: "relaunching", info };
          case "done":
            return { kind: "done" };
          case "error":
            return updateError(p.err ?? "update failed", info);
          default:
            return cur;
        }
      });
    });
  }, []);

  const check = useCallback(async () => {
    // A newer check may supersede an in-flight check (and historically may
    // interrupt apply). Discard owns exclusive recovery work and must not be
    // epoch-stolen by Check/Retry while AbandonPendingUpdate is outstanding.
    if (operationRef.current.kind === "abandoning") return;
    const operation = beginOperation("stable", "checking");
    setStatus({ kind: "checking" });
    try {
      const info = await app.CheckUpdate("stable");
      if (!isCurrentOperation(operation)) return;
      if (!info) {
        completeOperation(operation);
        setStatus({ kind: "upToDate", current: "" });
        return;
      }
      const responseChannel = normalizedChannel(info.channel);
      if (operation.channel && responseChannel !== operation.channel) {
        completeOperation(operation);
        setStatus(updateError(`update check returned ${responseChannel} for requested ${operation.channel} channel`));
        return;
      }
      operation.channel = responseChannel;
      operation.expectedVersion = info.latest;
      operationRef.current = { ...operation, kind: "ready" };
      if (info.err) {
        setStatus(updateError(info.err, info));
        return;
      }
      if (!info.available) {
        setStatus({ kind: "upToDate", current: info.current });
        return;
      }
      setStatus({ kind: "available", info });
    } catch (e) {
      if (!isCurrentOperation(operation)) return;
      completeOperation(operation);
      setStatus(updateError(errMsg(e)));
    }
  }, [beginOperation, completeOperation, isCurrentOperation]);

  const refresh = useCallback(async () => {
    if (isBusyOperation(operationRef.current.kind)) return;
    await check();
  }, [check]);

  const apply = useCallback((info: UpdateInfo) => {
    const selectedChannel = normalizedChannel(info.channel);
    if (selectedChannel !== "stable") {
      setStatus(updateError("update check returned a retired release channel"));
      return;
    }
    const active = operationRef.current;
    if (isBusyOperation(active.kind) || (active.channel && active.channel !== selectedChannel)) return;
    if (!info.canSelfUpdate) {
      void app.OpenDownloadPage();
      return;
    }
    const operation = beginOperation(selectedChannel, "applying", info.latest);
    setStatus(
      info.requiresElevation || info.installMode === "deb"
        ? { kind: "authorizing", info }
        : { kind: "downloading", received: 0, total: info.assetSize, info },
    );
    void app.ApplyUpdateRequest(selectedChannel, info.latest, operation.requestId).catch((e) => {
      if (!isCurrentOperation(operation)) return;
      const message = errMsg(e);
      completeOperation(operation);
      setStatus(updateError(message, info));
    });
  }, [beginOperation, completeOperation, isCurrentOperation]);

  const openDownload = useCallback(() => {
    void app.OpenDownloadPage();
  }, []);

  const [versions, setVersions] = useState<UpdateVersionList | null>(null);

  // listVersions loads the version list the Settings panel shows. It reuses the
  // check operation kind so a check and a list load cannot both own the state
  // machine, and it publishes the list itself rather than a status line.
  const listVersions = useCallback(async () => {
    if (isBusyOperation(operationRef.current.kind)) return;
    const operation = beginOperation("stable", "checking");
    setStatus({ kind: "checking" });
    try {
      const list = await app.ListUpdateVersions("stable");
      if (!isCurrentOperation(operation)) return;
      completeOperation(operation);
      setVersions(list);
      if (list?.err) {
        setStatus(updateError(list.err));
        return;
      }
      setStatus({ kind: "idle" });
    } catch (e) {
      if (!isCurrentOperation(operation)) return;
      completeOperation(operation);
      setStatus(updateError(errMsg(e)));
    }
  }, [beginOperation, completeOperation, isCurrentOperation]);

  // applyVersion runs the same download -> verify -> install -> relaunch
  // sequence as apply, but for a version the user picked from the list. Versions
  // reach the list without an UpdateInfo, so the payload here carries only what
  // the progress UI needs.
  const applyVersion = useCallback((version: string) => {
    if (!version) return;
    const active = operationRef.current;
    if (isBusyOperation(active.kind)) return;
    if (versions && !versions.canSelfUpdate) {
      void app.OpenDownloadPage();
      return;
    }
    const operation = beginOperation("stable", "applying", version);
    // Mirror apply(): a package install waits for authorization before any
    // download progress, and the list payload carries that machine-level fact.
    setStatus(
      versions && (versions.requiresElevation || versions.installMode === "deb")
        ? { kind: "authorizing" }
        : { kind: "downloading", received: 0, total: 0 },
    );
    void app.ApplyUpdateToVersion("stable", version, operation.requestId).catch((e) => {
      if (!isCurrentOperation(operation)) return;
      const message = errMsg(e);
      completeOperation(operation);
      setStatus(updateError(message));
    });
  }, [versions, beginOperation, completeOperation, isCurrentOperation]);

  const abandonPending = useCallback(async () => {
    const active = operationRef.current;
    if (isBusyOperation(active.kind)) return;
    // Publish busy UI immediately so Settings/Banner disable Retry/Check while
    // the discard promise is outstanding. Kind "abandoning" is distinct from
    // "checking" so a concurrent check cannot supersede the discard epoch.
    const operation = beginOperation(active.channel || "stable", "abandoning");
    setStatus({ kind: "checking" });
    try {
      if (typeof app.AbandonPendingUpdate === "function") {
        await app.AbandonPendingUpdate();
      }
      if (!isCurrentOperation(operation)) return;
      completeOperation(operation);
      setStatus({ kind: "idle" });
    } catch (e) {
      if (!isCurrentOperation(operation)) return;
      completeOperation(operation);
      setStatus(updateError(errMsg(e)));
    }
  }, [beginOperation, completeOperation, isCurrentOperation]);

  const reset = useCallback(() => {
    const epoch = operationRef.current.epoch + 1;
    operationRef.current = {
      epoch,
      requestId: nextUpdaterRequestId(epoch),
      channel: "",
      expectedVersion: "",
      kind: "idle",
    };
    setStatus({ kind: "idle" });
  }, []);

  return { status, check, refresh, apply, versions, listVersions, applyVersion, openDownload, abandonPending, reset };
}

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const updater = useUpdaterInternal();
  return createElement(UpdaterContext.Provider, { value: updater, children });
}

export function useUpdater(): Updater {
  const updater = useContext(UpdaterContext);
  if (!updater) throw new Error("useUpdater must be used within an UpdaterProvider");
  return updater;
}
