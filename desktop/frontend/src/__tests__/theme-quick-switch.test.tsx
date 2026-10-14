// The sidebar light/dark quick switch must change only the current display
// while the configured mode is automatic, and must write the setting when the
// mode is fixed. It also has to repaint when an automatic transition moves the
// resolved theme underneath it.
//
// Run: tsx src/__tests__/theme-quick-switch.test.tsx

import assert from "node:assert/strict";
import { managementDom } from "../test-support/managementDom";

// managementDom stubs matchMedia to matches:true, so auto resolves to light.
const dom = managementDom();
const { applyTheme, getTheme, getResolvedTheme, getThemeOverride, setThemeOverride, clearThemeOverride, subscribeResolvedTheme } =
  await import("../lib/theme");
const { useThemeQuickSwitch } = await import("../app-runtime/useThemeQuickSwitch");
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ThemeQuickSwitch } = await import("../app-shell/ThemeQuickSwitch");

const dataTheme = () => document.documentElement.getAttribute("data-theme");

// --- 1. fixed light/dark: the switch writes the setting, never an override ---
applyTheme("light", "graphite", { persist: false });
assert.equal(getTheme(), "light");
assert.equal(setThemeOverride("dark"), false, "a fixed mode refuses a session override");
assert.equal(getThemeOverride(), null);
assert.equal(getResolvedTheme(), "light", "a fixed mode is not overridden");

// --- 2. auto: the switch writes a session override and pins data-theme ---
applyTheme("auto", "graphite", { persist: false });
assert.equal(getResolvedTheme(), "light", "auto resolves from the OS preference (stubbed light)");
assert.equal(dataTheme(), null, "plain auto leaves data-theme unset so CSS follows the OS");
assert.equal(setThemeOverride("dark"), true);
assert.equal(getTheme(), "auto", "the override never changes the configured mode");
assert.equal(getResolvedTheme(), "dark", "the override steers the resolved theme");
assert.equal(dataTheme(), "dark", "an override pins data-theme so the stylesheet honors it");
assert.equal(getThemeOverride(), "dark");
clearThemeOverride();
assert.equal(getThemeOverride(), null);
assert.equal(getResolvedTheme(), "light", "back to following auto");
assert.equal(dataTheme(), null, "clearing the override restores the auto attribute handling");

// --- 3. an automatic transition clears the override ---
// applyTheme is the single door every automatic decision goes through: the
// schedule tick, the settings load and the OS scheme listener all call it.
setThemeOverride("dark");
assert.equal(getThemeOverride(), "dark");
applyTheme("auto", "graphite", { persist: false }); // a schedule tick / settings load
assert.equal(getThemeOverride(), null, "a fresh theme application drops the session override");

// --- 4. subscribers fire only when the resolved theme moves ---
let notified = 0;
const unsubscribe = subscribeResolvedTheme(() => { notified += 1; });
applyTheme("auto", "graphite", { persist: false }); // still light
assert.equal(notified, 0, "no notification when the resolved theme is unchanged");
setThemeOverride("dark");
assert.equal(notified, 1, "flipping the override notifies subscribers");
clearThemeOverride();
assert.equal(notified, 2, "clearing the override notifies subscribers");
unsubscribe();

// --- 5. the hook routes by mode: override for auto, setting for fixed ---
let select!: (theme: "light" | "dark") => void;
function Harness() { select = useThemeQuickSwitch(); return null; }
const root = createRoot(document.getElementById("root")!);
await act(async () => { root.render(React.createElement(Harness)); });
// auto mode → session override; the configured mode must stay "auto".
applyTheme("auto", "graphite", { persist: false });
await act(async () => { select("dark"); });
assert.equal(getResolvedTheme(), "dark", "auto mode steers the display");
assert.equal(getTheme(), "auto", "auto mode leaves the configured mode untouched");
assert.equal(getThemeOverride(), "dark");
// fixed mode → the setting itself changes, so getTheme() moves.
applyTheme("light", "graphite", { persist: false });
await act(async () => { select("dark"); });
assert.equal(getTheme(), "dark", "a fixed mode rewrites the configured mode instead of overriding");
await act(async () => { root.unmount(); });

// --- 6. the control reflects, and drives, the resolved theme ---
applyTheme("auto", "graphite", { persist: false });
let picked: string | null = null;
const root2 = createRoot(document.getElementById("root")!);
const translator = ((key: string) => key) as Parameters<typeof ThemeQuickSwitch>[0]["t"];
await act(async () => {
  root2.render(React.createElement(ThemeQuickSwitch, { t: translator, onSelect: (theme) => { picked = theme; setThemeOverride(theme); } }));
});
const positions = () => [...document.querySelectorAll<HTMLButtonElement>(".sidebar__theme-switch__opt")];
assert.equal(positions().length, 2, "two positions: light and dark");
assert.equal(positions()[0].classList.contains("is-on"), true, "auto resolving light marks light active");
assert.equal(positions()[0].getAttribute("aria-pressed"), "true");
assert.equal(positions()[1].getAttribute("aria-pressed"), "false");
await act(async () => { positions()[1].click(); });
assert.equal(picked, "dark", "clicking the dark position reports dark");
assert.equal(positions()[1].getAttribute("aria-pressed"), "true", "the control follows the resolved theme once it moves");
assert.equal(positions()[0].getAttribute("aria-pressed"), "false");
await act(async () => { root2.unmount(); });

dom.window.close();
console.log("PASS theme quick switch: session override only for auto/schedule, setting write for fixed, auto transitions clear it, control follows resolved");
