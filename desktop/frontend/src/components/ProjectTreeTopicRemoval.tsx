import { Fragment } from "react";
import type { ReactNode } from "react";
import { Archive, Trash2 } from "lucide-react";
import { Tooltip } from "./Tooltip";
import type { ContextMenuItem } from "./ContextMenu";

// Sidebar removal modes. Archiving publishes a recoverable trash entry, so it
// fires on the first activation like pinning does. Only "purge" — which deletes
// the session files in place — arms on the first click and waits for a second.
// An armed purge leaves the icon untouched and slides a hint out to its left, so
// the row always shows that a delete is pending and releasing it is visible.
export type ProjectTreeRemovalMode = "trash" | "purge";

export type ProjectTreeRemovalOptions = {
  blocked: boolean;
  busy: boolean;
  /** True while the permanent delete is awaiting its confirming click. */
  armed: boolean;
  labels: { trash: string; purge: string; purgeConfirm: string; purgeHint: string };
  onSelect: (mode: ProjectTreeRemovalMode) => void;
};

const removalModes = ["trash", "purge"] as const;

function removalKind(mode: ProjectTreeRemovalMode): "archive" | "delete" {
  return mode === "purge" ? "delete" : "archive";
}

function removalText(options: ProjectTreeRemovalOptions, mode: ProjectTreeRemovalMode): string {
  if (mode === "purge" && options.armed) return options.labels.purgeConfirm;
  return mode === "purge" ? options.labels.purge : options.labels.trash;
}

export function projectTreeRemovalButtons(options: ProjectTreeRemovalOptions): ReactNode {
  return removalModes.map((mode) => {
    const label = removalText(options, mode);
    const kind = removalKind(mode);
    const armed = mode === "purge" && options.armed;
    const spinner = options.busy ? " project-tree__topic-action--busy" : "";
    const armedClass = armed ? " project-tree__topic-action--delete-armed" : "";
    return (
      <Fragment key={mode}>
        {armed && (
          <span className="project-tree__topic-action-hint" role="status">
            {options.labels.purgeHint}
          </span>
        )}
        <Tooltip label={label} side="top" className="project-tree__topic-action-slot">
          <button
            className={`project-tree__topic-action project-tree__topic-action--${kind}${armedClass}${spinner}`}
            type="button" aria-label={label} aria-busy={options.busy} disabled={options.blocked || options.busy}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); options.onSelect(mode); }}
          >
            {mode === "purge"
              ? <Trash2 size={15} aria-hidden="true" />
              : <Archive className={options.busy ? "project-tree__archive-spinner" : undefined} size={15} aria-hidden="true" />}
          </button>
        </Tooltip>
      </Fragment>
    );
  });
}

// A context menu is already an overlay, so it cannot slide anything out beside its
// items. It keeps the label swap, which states the same thing the row hint does.
export function projectTreeRemovalMenuItems(options: ProjectTreeRemovalOptions): ContextMenuItem[] {
  return removalModes.map((mode) => ({
    key: mode,
    icon: mode === "purge"
      ? <Trash2 size={13} />
      : <Archive className={options.busy ? "project-tree__archive-spinner" : undefined} size={13} />,
    label: removalText(options, mode),
    disabled: options.blocked || options.busy,
    danger: true,
    onSelect: () => options.onSelect(mode),
  }));
}
