import { Archive, Trash2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from "./ContextMenu";

type ProjectTreeSessionArchiveMenuProps = {
  open: boolean;
  point: ContextMenuPoint | null;
  sessionPath: string;
  blocked: boolean;
  busy: boolean;
  confirmed: boolean;
  confirmedDelete: boolean;
  onConfirm: () => void;
  onTrash: () => void;
  onConfirmDelete: () => void;
  onPurge: () => void;
  onClose: () => void;
};

export function ProjectTreeSessionArchiveMenu({
  open, point, sessionPath, blocked, busy, confirmed, confirmedDelete,
  onConfirm, onTrash, onConfirmDelete, onPurge, onClose,
}: ProjectTreeSessionArchiveMenuProps) {
  const t = useT();
  const items: ContextMenuItem[] = [
    {
      key: "trash-session",
      icon: <Archive className={busy ? "project-tree__archive-spinner" : undefined} size={13} />,
      label: t(confirmed ? "history.confirmMoveToTrash" : "history.moveToTrash"),
      disabled: !sessionPath || blocked || busy,
      danger: true,
      onSelect: confirmed ? onTrash : onConfirm,
    },
    {
      key: "purge-session",
      icon: <Trash2 size={13} />,
      label: t(confirmedDelete ? "history.confirmDeletePermanently" : "history.deletePermanently"),
      disabled: !sessionPath || blocked || busy,
      danger: true,
      onSelect: confirmedDelete ? onPurge : onConfirmDelete,
    },
  ];
  return <ContextMenu open={open} point={point} items={items} minWidth={178} ariaLabel={t("projectTree.topicActions")} onClose={onClose} />;
}
