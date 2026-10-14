import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import { RemoteHostKeyDialog } from "../components/RemoteHostKeyDialog";
import { RemoteSecretDialog } from "../components/RemoteSecretDialog";
import { StartupSplash } from "../components/StartupSplash";
import { ManagementSurface } from "../components/ManagementSurface";

const HistoryPanel = lazy(() => import("../components/HistoryPanel").then((module) => ({ default: module.HistoryPanel })));
const SessionRecoveryVersionsHost = lazy(() => import("../components/SessionRecoveryVersionsHost").then((module) => ({ default: module.SessionRecoveryVersionsHost })));
const loadSettingsPage = () => import("../components/SettingsPanelEntry").then((module) => ({ default: module.SettingsPanel }));
const loadTrashPage = () => import("../components/TrashPage").then((module) => ({ default: module.TrashPage }));
const loadAutomationPage = () => import("../custom/features/heartbeat/HeartbeatPanel").then((module) => ({ default: module.HeartbeatView }));
const loadShortcutsCheatsheet = () => import("../components/ShortcutsCheatsheet").then((module) => ({ default: module.ShortcutsCheatsheet }));
type LoadedProps<T> = T extends () => Promise<{ default: React.ComponentType<infer Props> }> ? Props : never;
const ShortcutsCheatsheet = lazy(loadShortcutsCheatsheet);
const CommandPalette = lazy(() => import("../components/CommandPalette").then((module) => ({ default: module.CommandPalette })));
const TranscriptSelectionMenu = lazy(() => import("../components/TranscriptSelectionMenu").then((module) => ({ default: module.TranscriptSelectionMenu })));
const WorktreeMergeModal = lazy(() => import("../components/WorktreeMergeModal").then((module) => ({ default: module.WorktreeMergeModal })));

type Region<Props, ViewKey extends keyof Props> = {
  view: Pick<Props, ViewKey>;
  commands: Omit<Props, ViewKey>;
};

export type AppOverlayHostProps = {
  history?: Region<ComponentProps<typeof HistoryPanel>, "kind" | "sessions" | "running">;
  recovery: Region<ComponentProps<typeof SessionRecoveryVersionsHost>, "sessions">;
  settings?: Region<LoadedProps<typeof loadSettingsPage>, "initialTab" | "initialFocus" | "agentRunning" | "desktopPlatform" | "activeWorkspaceKey">;
  trash?: Region<LoadedProps<typeof loadTrashPage>, "active">;
  automation?: Region<LoadedProps<typeof loadAutomationPage>, "active">;
  palette?: Region<ComponentProps<typeof CommandPalette>, "open" | "items" | "placeholder" | "emptyText">;
  shortcuts: Region<LoadedProps<typeof loadShortcutsCheatsheet>, "open" | "platform" | "t">;
  startup?: Region<ComponentProps<typeof StartupSplash>, "hold">;
  selection: Region<ComponentProps<typeof TranscriptSelectionMenu>, "enabled" | "resetKey">;
  worktree?: Region<ComponentProps<typeof WorktreeMergeModal>, "tabId" | "isOpen">;
};

function ShortcutsCheatsheetRegion({ shortcuts }: { shortcuts: AppOverlayHostProps["shortcuts"] }) {
  const [hasOpened, setHasOpened] = useState(shortcuts.view.open);
  useEffect(() => {
    if (shortcuts.view.open) setHasOpened(true);
  }, [shortcuts.view.open]);
  if (!hasOpened) return null;
  return <Suspense fallback={null}><ShortcutsCheatsheet {...shortcuts.view} {...shortcuts.commands} /></Suspense>;
}

/** Presentation-only overlay region. Async ownership stays in feature owners. */
export function AppOverlayHost({ history, recovery, settings, trash, automation, palette, shortcuts, startup, selection, worktree }: AppOverlayHostProps) {
  return (
    <>
      {history && <Suspense fallback={null}><HistoryPanel {...history.view} {...history.commands} /></Suspense>}
      <Suspense fallback={null}><SessionRecoveryVersionsHost {...recovery.view} {...recovery.commands} /></Suspense>
      {trash && <ManagementSurface loader={loadTrashPage} active={trash.view.active} onBack={trash.commands.onBack}
        surfaceProps={{ ...trash.view, ...trash.commands }} />}
      {automation && <ManagementSurface loader={loadAutomationPage} active={automation.view.active !== false} onBack={automation.commands.onBack!}
        surfaceProps={{ ...automation.view, ...automation.commands }} />}
      {settings && <ManagementSurface loader={loadSettingsPage} active onBack={settings.commands.onClose}
        surfaceProps={{ ...settings.view, ...settings.commands }} />}
      <RemoteHostKeyDialog />
      <RemoteSecretDialog />
      {palette && <Suspense fallback={null}><CommandPalette {...palette.view} {...palette.commands} /></Suspense>}
      <ShortcutsCheatsheetRegion shortcuts={shortcuts} />
      {startup && <StartupSplash {...startup.view} {...startup.commands} />}
      <Suspense fallback={null}><TranscriptSelectionMenu {...selection.view} {...selection.commands} /></Suspense>
      {worktree && <Suspense fallback={null}><WorktreeMergeModal {...worktree.view} {...worktree.commands} /></Suspense>}
    </>
  );
}
