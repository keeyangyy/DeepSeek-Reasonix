import { Archive, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";
import type { ContextMenuItem } from "./ContextMenu";

// Sidebar removal modes: "trash" publishes a recoverable trash entry, "purge"
// deletes the session files in place. Both arm on the first activation so a
// permanent delete always takes two deliberate clicks.
export type ProjectTreeRemovalMode = "trash" | "purge";

export type ProjectTreeRemovalOptions = {
  blocked: boolean;
  busy: boolean;
  armed: { trash: boolean; purge: boolean };
  labels: { trash: string; trashConfirm: string; purge: string; purgeConfirm: string };
  onSelect: (mode: ProjectTreeRemovalMode) => void;
};

const removalModes = ["trash", "purge"] as const;

function removalKind(mode: ProjectTreeRemovalMode): "archive" | "delete" {
  return mode === "purge" ? "delete" : "archive";
}

function removalText(options: ProjectTreeRemovalOptions, mode: ProjectTreeRemovalMode): string {
  const purge = mode === "purge";
  if (options.armed[mode]) return purge ? options.labels.purgeConfirm : options.labels.trashConfirm;
  return purge ? options.labels.purge : options.labels.trash;
}

export function projectTreeRemovalButtons(options: ProjectTreeRemovalOptions): ReactNode {
  return removalModes.map((mode) => {
    const label = removalText(options, mode);
    const kind = removalKind(mode);
    const spinner = options.busy ? " project-tree__topic-action--busy" : "";
    const armedClass = options.armed[mode] ? ` project-tree__topic-action--${kind}-armed` : "";
    return (
      <Tooltip key={mode} label={label} side="top" className="project-tree__topic-action-slot">
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
    );
  });
}

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
