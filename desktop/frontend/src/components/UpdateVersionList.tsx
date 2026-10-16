import { useT } from "../lib/i18n";
import type { UpdateVersionList as UpdateVersionListPayload } from "../lib/updateVersions";

// UpdateVersionList renders the versions the update panel may offer: newest
// first, one row per catalog entry, with a channel badge and the running build
// marked in place of an install action.
export function UpdateVersionList({
  list,
  busy,
  onInstall,
}: {
  list: UpdateVersionListPayload;
  busy: boolean;
  onInstall: (version: string) => void;
}) {
  const t = useT();
  if (list.entries.length === 0) return null;
  return (
    <div className="updates-control__versions" role="list" aria-label={t("updater.versionListTitle")}>
      {list.entries.map((entry) => (
        <div className="updates-control__version-row" role="listitem" key={entry.version}>
          <span className="updates-control__version-tag">{entry.version}</span>
          <span
            className={`updates-control__channel updates-control__channel--${entry.channel === "beta" ? "beta" : "stable"}`}
          >
            {entry.channel === "beta" ? t("updater.channelBeta") : t("updater.channelStable")}
          </span>
          {entry.publishedAt && (
            <span className="updates-control__version-date">{entry.publishedAt.slice(0, 10)}</span>
          )}
          <span className="banner__spacer" />
          {entry.current ? (
            <span className="updates-control__version-current">{t("updater.versionCurrent")}</span>
          ) : (
            <button className="btn btn--small" type="button" disabled={busy} onClick={() => onInstall(entry.version)}>
              {list.canSelfUpdate ? t("updater.versionInstall") : t("updater.goToDownload")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}