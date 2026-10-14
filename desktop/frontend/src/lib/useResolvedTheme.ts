// useResolvedTheme subscribes React to the light/dark the window is currently
// painting. Theme state lives outside React (lib/theme.ts owns the DOM), so the
// sidebar quick switch reads it through useSyncExternalStore and repaints when
// an automatic transition or a settings change moves it.

import { useSyncExternalStore } from "react";
import { getResolvedTheme, getTheme, getThemeOverride, subscribeResolvedTheme } from "./theme";

export function useResolvedTheme(): { resolved: "light" | "dark"; mode: ReturnType<typeof getTheme>; overridden: boolean } {
  const resolved = useSyncExternalStore(subscribeResolvedTheme, getResolvedTheme, () => "dark" as const);
  const mode = useSyncExternalStore(subscribeResolvedTheme, getTheme, () => getTheme());
  const override = useSyncExternalStore(subscribeResolvedTheme, getThemeOverride, () => null);
  return { resolved, mode, overridden: override !== null };
}
