import { Archive, Trash2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from "./ContextMenu";

type ProjectTreeSessionArchiveMenuProps = {
  open: boolean;
  point: ContextMenuPoint | null;
  sessionPath: string;
  blocked: boolean;
  busy: boolean;
  confirmedDelete: boolean;
  onTrash: () => void;
  onPurge: () => void;
  onClose: () => void;
};

// Archiving a session publishes a recoverable trash entry, so it runs on the first
// activation; only the unrecoverable delete waits for a confirming second one.
export function ProjectTreeSessionArchiveMenu({
  open, point, sessionPath, blocked, busy, confirmedDelete,
  onTrash, onPurge, onClose,
}: ProjectTreeSessionArchiveMenuProps) {
  const t = useT();
  const items: ContextMenuItem[] = [
    {
      key: "trash-session",
      icon: <Archive className={busy ? "project-tree__archive-spinner" : undefined} size={13} />,
      label: t("history.moveToTrash"),
      disabled: !sessionPath || blocked || busy,
      danger: true,
      onSelect: onTrash,
    },
    {
      key: "purge-session",
      icon: <Trash2 size={13} />,
      label: t(confirmedDelete ? "history.confirmDeletePermanently" : "history.deletePermanently"),
      disabled: !sessionPath || blocked || busy,
      danger: true,
      onSelect: onPurge,
    },
  ];
  return <ContextMenu open={open} point={point} items={items} minWidth={178} ariaLabel={t("projectTree.topicActions")} onClose={onClose} />;
}
