import { useT } from "../lib/i18n";
import { useUpdater } from "../lib/useUpdater";

// UpdateVersionList renders the versions the update panel may offer: the newest
// five releases unioned with the newest three stable ones, newest first, one row
// per catalog entry, with a channel badge (stable in green) and the running
// build marked in place of an install action. It reads the updater itself so
// the Settings panel only mounts it, and it owns the list's own loading and
// error states: a failed catalog fetch is retried here without disturbing the
// update check that shares the panel.
const UPDATER_BUSY_KINDS = ["checking", "downloading", "verifying", "authorizing", "installing", "relaunching"];

export function UpdateVersionList({ settingsBusy = false }: { settingsBusy?: boolean }) {
  const t = useT();
  const { status, versions, versionsLoading, versionsError, listVersions, applyVersion } = useUpdater();
  const rows = versions?.entries ?? [];
  const busy = settingsBusy || UPDATER_BUSY_KINDS.includes(status.kind);
  if (rows.length === 0 && !versionsLoading && !versionsError) return null;
  return (
    <>
      {rows.length > 0 && (
        <div className="updates-control__versions" role="list" aria-label={t("updater.versionListTitle")}>
          {rows.map((entry) => (
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
                <button className="btn btn--small" type="button" disabled={busy} onClick={() => applyVersion(entry.version)}>
                  {versions?.canSelfUpdate ? t("updater.versionInstall") : t("updater.goToDownload")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 && versionsLoading && (
        <div className="updates-control__hint">
          <span>{t("updater.versionListLoading")}</span>
        </div>
      )}
      {rows.length === 0 && !versionsLoading && versionsError && (
        <div className="updates-control__hint">
          <span>{t("updater.versionListFailed", { msg: versionsError })}</span>
          <button className="btn btn--small" type="button" onClick={() => void listVersions()}>
            {t("updater.retry")}
          </button>
        </div>
      )}
    </>
  );
}