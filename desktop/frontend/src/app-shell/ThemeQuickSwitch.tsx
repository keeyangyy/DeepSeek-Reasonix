// ThemeQuickSwitch — the sidebar's light/dark toggle that sits just above the
// utility row. It is a two-position sliding switch, not a three-state picker:
// the window is always painting either light or dark, and this reflects (and
// steers) that.
//
// It never changes the persisted theme mode on its own. While the configured
// mode is automatic (auto/schedule) it writes a session-only override, which the
// automatic machinery clears on its next transition, and which a restart drops
// entirely. While the mode is a fixed light/dark it simply writes that setting —
// there the setting and the display are the same thing.

import { useResolvedTheme } from "../lib/useResolvedTheme";
import type { Translator } from "../lib/i18n";

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);
const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

export function ThemeQuickSwitch({ t, onSelect }: { t: Translator; onSelect: (theme: "light" | "dark") => void }) {
  const { resolved } = useResolvedTheme();
  return (
    <div className="sidebar__theme-switch" role="group" aria-label={t("sidebar.themeQuickSwitch")}>
      <span className="sidebar__theme-switch__thumb" data-state={resolved} aria-hidden="true" />
      <button type="button" className={`sidebar__theme-switch__opt${resolved === "light" ? " is-on" : ""}`}
        aria-pressed={resolved === "light"}
        title={t("settings.themeLight")} onClick={() => onSelect("light")}>
        <SunIcon /><span>{t("settings.themeLight")}</span>
      </button>
      <button type="button" className={`sidebar__theme-switch__opt${resolved === "dark" ? " is-on" : ""}`}
        aria-pressed={resolved === "dark"}
        title={t("settings.themeDark")} onClick={() => onSelect("dark")}>
        <MoonIcon /><span>{t("settings.themeDark")}</span>
      </button>
    </div>
  );
}
