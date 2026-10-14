// useThemeQuickSwitch resolves what the sidebar light/dark switch should do for
// the currently configured theme mode:
//
//  - auto / schedule  → a session-only override. The persisted mode is left
//    alone, so the automatic machinery keeps owning it: a schedule tick or an OS
//    scheme change clears the override, and a restart starts fresh.
//  - light / dark     → the display *is* the setting, so write the setting.
//
// Returns the handler the sidebar passes to ThemeQuickSwitch.

import { useCallback } from "react";
import { setThemeOverride } from "../lib/theme";
import { setThemeMode } from "../lib/themeExperience";
import { useCommittedCommand } from "../lib/useCommittedCommand";

export function useThemeQuickSwitch(): (theme: "light" | "dark") => void {
  const select = useCommittedCommand(async (theme: "light" | "dark") => {
    // setThemeOverride returns false for a fixed mode; there the setting must
    // change instead, matching what the appearance page would do.
    if (setThemeOverride(theme)) return;
    await setThemeMode(theme);
  });
  return useCallback((theme: "light" | "dark") => { void select(theme); }, [select]);
}
