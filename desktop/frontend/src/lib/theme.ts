// theme.ts manages the appearance override. The stylesheet follows the OS via
// prefers-color-scheme unless data-theme forces "dark" or "light". A separate
// data-theme-style attribute selects a visual direction (graphite/aurora/slate/
// carbon/nocturne/amber) — orthogonal to theme, so every direction supports both
// light & dark.
//
// When running inside the Wails shell, applyTheme also syncs the native window
// theme (title bar, traffic lights, etc.) so the OS chrome matches the webview.

import { baseCodeReadabilityStylesheet } from "./codeReadability";
import { isDarkSchedule, nextScheduleTransition } from "./themeSchedule";

export type Theme = "auto" | "light" | "dark" | "schedule";
export type ResolvedTheme = Exclude<Theme, "auto" | "schedule">;

export const THEME_STYLES = [
  "graphite",
  "aurora",
  "slate",
  "carbon",
  "nocturne",
  "amber",
] as const;

export type ThemeStyle = (typeof THEME_STYLES)[number];

// Old style identifiers map to the closest new direction so settings stored
// from previous versions still resolve to a valid value.
const LEGACY_STYLE_MAP: Record<string, ThemeStyle> = {
  ember: "carbon",
  midnight: "nocturne",
  sandstone: "amber",
  porcelain: "nocturne",
  linen: "amber",
  glacier: "slate",
};

const DEFAULT_THEME_STYLE: ThemeStyle = "graphite";
const DEFAULT_THEME: Theme = "auto";

const THEME_KEY = "reasonix-theme";
const STYLE_KEY = "reasonix-theme-style";
const AUTO_THEME_MEDIA_QUERY = "(prefers-color-scheme: light)";
const BASE_CODE_READABILITY_STYLE_ID = "reasonix-base-code-readability";
let currentTheme: Theme = DEFAULT_THEME;
let currentThemeStyle: ThemeStyle = DEFAULT_THEME_STYLE;
let autoThemeMediaQuery: MediaQueryList | null = null;
// currentSchedule holds the dark-window bounds for schedule mode ("HH:MM").
// Empty strings mean "not configured" and make schedule resolve like auto.
let currentSchedule: { start: string; end: string } = { start: "", end: "" };
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

export function normalizeThemePreference(value: unknown): Theme {
  if (typeof value === "object" && value !== null) {
    return normalizeThemePreference((value as { mode?: unknown }).mode);
  }
  if (typeof value !== "string") return DEFAULT_THEME;
  switch (value) {
    case "auto":
      return "auto";
    case "schedule":
      return "schedule";
    case "light":
    case "focus":
    case "forest":
      return "light";
    case "dark":
    case "midnight":
    case "contrast":
      return "dark";
    default:
      return DEFAULT_THEME;
  }
}

export function isThemeStyle(value: unknown): value is ThemeStyle {
  return typeof value === "string" && (THEME_STYLES as readonly string[]).includes(value);
}

export function getTheme(): Theme {
  return currentTheme;
}

export function getResolvedTheme(theme: Theme = getTheme()): ResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (theme === "schedule") {
    // An unconfigured schedule falls back to the OS preference so enabling
    // the mode without setting a window never forces a jarring colour.
    if (currentSchedule.start && currentSchedule.end) {
      return isDarkSchedule(currentSchedule.start, currentSchedule.end, new Date()) ? "dark" : "light";
    }
  }
  if (typeof window !== "undefined" && window.matchMedia?.(AUTO_THEME_MEDIA_QUERY).matches) return "light";
  return "dark";
}

// setThemeSchedule records the dark-window bounds ("HH:MM" each) used by
// schedule mode and re-applies immediately when schedule is active.
export function setThemeSchedule(start: string, end: string): void {
  currentSchedule = { start, end };
  if (currentTheme === "schedule" && typeof document !== "undefined") {
    applyTheme(currentTheme, currentThemeStyle, { persist: false });
  }
}

// Direction is orthogonal to theme, but keep this helper so callers that
// stored values in the old "style implies theme" model can still ask.
export function defaultStyleForTheme(_theme: Theme = getTheme()): ThemeStyle {
  return DEFAULT_THEME_STYLE;
}

// themeForStyle previously returned the dark/light forced by the style. Style
// is now independent of theme, so we keep the current theme.
export function themeForStyle(_style: ThemeStyle): ResolvedTheme {
  return getResolvedTheme();
}

export function getThemeStyle(_theme: Theme = getTheme()): ThemeStyle {
  return currentThemeStyle;
}

export function normalizeThemeStyleForTheme(style: string | undefined, _theme?: Theme): ThemeStyle {
  if (typeof style !== "string") return DEFAULT_THEME_STYLE;
  if (isThemeStyle(style)) return style;
  return LEGACY_STYLE_MAP[style] ?? DEFAULT_THEME_STYLE;
}

export function applyTheme(theme: Theme, style: ThemeStyle = getThemeStyle(theme), options: { persist?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  ensureBaseCodeReadabilityStyle();
  const root = document.documentElement;
  root.removeAttribute("data-theme-mode");
  root.removeAttribute("data-theme-scheme");
  // schedule resolves to light/dark before touching the DOM: the stylesheet
  // only understands the concrete values.
  const resolved = getResolvedTheme(theme);
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", resolved);

  const nextStyle: ThemeStyle = isThemeStyle(style) ? style : DEFAULT_THEME_STYLE;
  currentTheme = theme;
  currentThemeStyle = nextStyle;
  root.setAttribute("data-theme-style", nextStyle);

  // Sync the native window theme (title bar, traffic lights) to match.
  const runtime = typeof window !== "undefined" ? window.runtime : undefined;
  if (runtime) {
    syncAutoThemeBackgroundListener(theme);
    if (theme === "auto") {
      runtime.WindowSetSystemDefaultTheme?.();
    } else if (resolved === "light") {
      runtime.WindowSetLightTheme?.();
    } else {
      runtime.WindowSetDarkTheme?.();
    }
    syncNativeWindowBackground(theme);
  }

  armScheduleTimer(theme);
  void options;
}

// armScheduleTimer chains a timeout to the next dark/light transition while
// schedule mode is active. Each tick re-arms the next one, so a long-running
// app never drifts; any other theme mode clears the timer.
function armScheduleTimer(theme: Theme): void {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  if (theme !== "schedule") return;
  const next = nextScheduleTransition(currentSchedule.start, currentSchedule.end, new Date());
  if (!next) return;
  const delay = Math.max(0, next.at.getTime() - Date.now()) + 250; // small grace past the minute boundary
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    if (currentTheme === "schedule") {
      applyTheme(currentTheme, currentThemeStyle, { persist: false });
    }
  }, delay);
}

function ensureBaseCodeReadabilityStyle(): void {
  if (document.getElementById(BASE_CODE_READABILITY_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BASE_CODE_READABILITY_STYLE_ID;
  style.textContent = baseCodeReadabilityStylesheet(THEME_STYLES);
  document.head.appendChild(style);
}

function syncAutoThemeBackgroundListener(theme: Theme): void {
  if (theme !== "auto") {
    clearAutoThemeBackgroundListener();
    return;
  }
  if (autoThemeMediaQuery || typeof window === "undefined" || !window.matchMedia) return;
  autoThemeMediaQuery = window.matchMedia(AUTO_THEME_MEDIA_QUERY);
  if (typeof autoThemeMediaQuery.addEventListener === "function") {
    autoThemeMediaQuery.addEventListener("change", syncAutoThemeBackground);
  } else {
    autoThemeMediaQuery.addListener(syncAutoThemeBackground);
  }
}

function clearAutoThemeBackgroundListener(): void {
  if (!autoThemeMediaQuery) return;
  if (typeof autoThemeMediaQuery.removeEventListener === "function") {
    autoThemeMediaQuery.removeEventListener("change", syncAutoThemeBackground);
  } else {
    autoThemeMediaQuery.removeListener(syncAutoThemeBackground);
  }
  autoThemeMediaQuery = null;
}

function syncAutoThemeBackground(): void {
  if (currentTheme === "auto" && typeof window !== "undefined" && window.runtime) {
    syncNativeWindowBackground("auto");
  }
}

export function readLegacyThemePreference(): { theme: Theme; style: ThemeStyle; hasValue: boolean } {
  if (typeof localStorage === "undefined") return { theme: DEFAULT_THEME, style: DEFAULT_THEME_STYLE, hasValue: false };
  let rawTheme: string | null = null;
  let rawStyle: string | null = null;
  try {
    rawTheme = localStorage.getItem(THEME_KEY);
    rawStyle = localStorage.getItem(STYLE_KEY);
  } catch {
    return { theme: DEFAULT_THEME, style: DEFAULT_THEME_STYLE, hasValue: false };
  }
  const hasValue = rawTheme !== null || rawStyle !== null;
  let theme = DEFAULT_THEME;
  if (rawTheme) {
    try {
      theme = normalizeThemePreference(JSON.parse(rawTheme) as unknown);
    } catch {
      theme = normalizeThemePreference(rawTheme);
    }
  }
  const style = normalizeThemeStyleForTheme(rawStyle ?? undefined, theme);
  return { theme, style, hasValue };
}

export function clearLegacyThemePreference(): void {
  try {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(STYLE_KEY);
  } catch {
    /* ignore storage failures */
  }
}

// initTheme runs before React mounts. It applies the saved theme to the DOM and
// sets the native window background colour to match the resolved theme, avoiding
// a white (or wrong-colour) flash while the webview paints its first frame.
export function initTheme(): void {
  const theme = getTheme();
  applyTheme(theme, getThemeStyle(theme), { persist: false });
}

function syncNativeWindowBackground(theme: Theme): void {
  const runtime = typeof window !== "undefined" ? window.runtime : undefined;
  if (!runtime?.WindowSetBackgroundColour) return;
  const resolved = getResolvedTheme(theme);
  if (resolved === "light") {
    // Light shell: matches graphite --bg (#f4f3ef).
    runtime.WindowSetBackgroundColour(244, 243, 239, 255);
  } else {
    // Dark shell: matches :root --bg (#090a0c).
    runtime.WindowSetBackgroundColour(9, 10, 12, 255);
  }
}
