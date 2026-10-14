import { useT } from "../lib/i18n";

// Trash bulk-action bar. The selection itself lives in HistoryPanel; this only
// renders the controls. "Select all" targets the sessions currently visible
// after filtering, so a bulk delete never reaches rows the filters hid.
export function HistorySelectionBar({
  selectedCount,
  selectableCount,
  busy,
  onSelectAll,
  onClearSelected,
  onRestoreSelected,
  onPurgeSelected,
}: {
  selectedCount: number;
  selectableCount: number;
  busy: boolean;
  onSelectAll: () => void;
  onClearSelected: () => void;
  onRestoreSelected: () => void;
  onPurgeSelected: () => void;
}) {
  const t = useT();
  const allSelected = selectableCount > 0 && selectedCount >= selectableCount;
  const noneSelected = selectedCount === 0;
  return (
    <div className="history-selection" role="group" aria-label={t("history.selectionGroup")}>
      <button
        type="button"
        className="chip"
        disabled={busy || selectableCount === 0}
        onClick={allSelected ? onClearSelected : onSelectAll}
      >
        {t(allSelected ? "history.deselectAll" : "history.selectAll")}
      </button>
      <span className="history-selection__count" aria-live="polite">
        {t("history.selectedCount", { n: selectedCount })}
      </span>
      <span className="history-selection__spacer" />
      <button type="button" className="btn btn--primary btn--small" disabled={busy || noneSelected} onClick={onRestoreSelected}>
        {t("history.restoreSelected")}
      </button>
      <button type="button" className="btn btn--small btn--danger" disabled={busy || noneSelected} onClick={onPurgeSelected}>
        {t("history.purgeSelected")}
      </button>
    </div>
  );
}