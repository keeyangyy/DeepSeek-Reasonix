// The version list the update panel shows (desktop/update_catalog.go):
// ListUpdateVersions returns these entries newest first, and each one installs
// through ApplyUpdateToVersion. The install-profile fields are list-level
// because they describe this machine, not one version.

export interface UpdateVersion {
  version: string;
  channel: "stable" | "beta" | string;
  publishedAt?: string;
  current: boolean;
  installable: boolean;
  manifestUrl: string;
}

export interface UpdateVersionList {
  current: string;
  canSelfUpdate: boolean;
  manualReason?: string;
  installMode?: string;
  requiresElevation?: boolean;
  entries: UpdateVersion[];
  err?: string;
}

// previewVersionList is the browser-dev stand-in for the backend's catalog
// fetch: the newest five of this line's real releases — exactly what
// `catalogfilter -recent 5 -recent-stable 3` yields today — so the Settings
// panel can be previewed without a published catalog. canSelfUpdate mirrors a
// real portable install, which is what makes the rows offer an install action.
export function previewVersionList(current: string): UpdateVersionList {
  const entry = (
    version: string,
    channel: "stable" | "beta",
    publishedAt: string,
  ): UpdateVersion => ({
    version,
    channel,
    publishedAt,
    current: version === current,
    installable: version !== current,
    manifestUrl: "",
  });
  return {
    current,
    canSelfUpdate: true,
    installMode: "portable",
    entries: [
      entry("v1.38.54-beta.2", "beta", "2026-10-16T12:41:11Z"),
      entry("v1.38.54-beta.1", "beta", "2026-10-14T07:37:23Z"),
      entry("v1.38.53", "stable", "2026-10-12T05:42:11Z"),
      entry("v1.38.52", "stable", "2026-10-11T18:32:04Z"),
      entry("v1.38.51", "stable", "2026-10-10T19:17:15Z"),
    ],
  };
}