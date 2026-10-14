import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) { return specifier.endsWith(".svg") ? nextResolve("./asset-stub-for-tests.ts", { ...context, parentURL: import.meta.url }) : nextResolve(specifier, context); } });
import assert from "node:assert/strict";
import { managementDom } from "../test-support/managementDom";
import type { SessionMeta } from "../lib/types";
const dom = managementDom();
const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocaleProvider } = await import("../lib/i18n");
const { TrashPage } = await import("../components/TrashPage");

// PreviewSession is the only bridge call TrashPage makes; keep it inert.
Object.assign(window, { go: { main: { App: { PreviewSession: async () => [] } } } });

const session = (id: string, turns: number, turnsState: SessionMeta["turnsState"]): SessionMeta => ({
  path: id, title: id, preview: id, turns, turnsState,
  createdAt: 1, lastActivityAt: 1, modTime: 1, deletedAt: Date.now(), current: false, open: false,
});
const sessions = [
  session("five", 5, "valid"),
  session("two", 2, "valid"),
  session("one", 1, "valid"),
  session("unknown", 0, "unknown"),
];
const root = createRoot(document.getElementById("root")!);
await act(async () => root.render(
  <LocaleProvider>
    <TrashPage active onBack={() => {}} list={async () => sessions} restore={async () => {}} purge={async () => {}} />
  </LocaleProvider>,
));
await act(async () => {});

const turnsGroup = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Turns"]');
assert.ok(turnsGroup(), "trash shows a Turns filter group");
const pills = () => Array.from(turnsGroup()!.querySelectorAll<HTMLButtonElement>("button"));
const pillLabel = (b: HTMLButtonElement) => (b.childNodes[0]?.textContent ?? "").trim();
const clickPill = async (label: string) => {
  const btn = pills().find((b) => pillLabel(b) === label);
  assert.ok(btn, `turns pill "${label}" exists`);
  await act(async () => btn!.click());
};
const itemCount = () => document.querySelectorAll(".hist-item").length;
const visibleIds = () => Array.from(document.querySelectorAll(".hist-item")).map((n) => n.textContent ?? "").join(" | ");

assert.deepEqual(pills().map(pillLabel), ["All", "1 turn", "≤3 turns", "≤5 turns"], "buckets render in cumulative order");
assert.deepEqual(pills().map((b) => b.querySelector(".history-filter__count")?.textContent), ["4", "1", "2", "3"],
  "buckets count authoritative turn counts only (unknown excluded)");

assert.equal(itemCount(), 4, "default All view lists every ordinary trashed session");
assert.ok(visibleIds().includes("unknown"), "unknown-count session is reachable under All");

await clickPill("≤3 turns");
assert.equal(itemCount(), 2, "≤3 turns keeps only the 1- and 2-turn sessions");
assert.ok(visibleIds().includes("one") && visibleIds().includes("two"));
assert.ok(!visibleIds().includes("five"), "5-turn session is above the ≤3 bucket");
assert.ok(!visibleIds().includes("unknown"), "unknown-count session never enters a turn bucket");

await clickPill("1 turn");
assert.equal(itemCount(), 1, "1 turn keeps only the single-turn session");
assert.ok(visibleIds().includes("one"));

await clickPill("≤5 turns");
assert.equal(itemCount(), 3, "≤5 turns keeps the 1-, 2- and 5-turn sessions");
assert.ok(visibleIds().includes("five"));
assert.ok(!visibleIds().includes("unknown"), "unknown-count session stays out of ≤5 too");

await clickPill("All");
assert.equal(itemCount(), 4, "All restores every session");

await act(async () => root.unmount());
dom.window.close();
console.log("PASS trash turns filter: cumulative buckets, authoritative counts, unknown-count exclusion");