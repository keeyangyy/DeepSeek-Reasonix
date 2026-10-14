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

let previewCalls = 0;
Object.assign(window, { go: { main: { App: { PreviewSession: async () => { previewCalls++; return []; } } } } });

const session = (id: string, turns: number, recoveryCopy = false): SessionMeta => ({
  path: id, title: id, preview: id, turns, turnsState: "valid",
  createdAt: 1, lastActivityAt: 1, modTime: 1, deletedAt: Date.now(), current: false, open: false, recoveryCopy,
});
let sessions = [session("a", 1), session("b", 1), session("c", 9), session("protected", 1, true)];
const calls: string[] = [];
const list = async () => sessions;
const purge = async (path: string) => { calls.push(`purge:${path}`); sessions = sessions.filter((s) => s.path !== path); };
const restore = async (path: string) => { calls.push(`restore:${path}`); sessions = sessions.filter((s) => s.path !== path); };
const root = createRoot(document.getElementById("root")!);
await act(async () => root.render(
  <LocaleProvider>
    <TrashPage active onBack={() => {}} list={list} purge={purge} restore={restore} />
  </LocaleProvider>,
));
await act(async () => {});

const checks = () => Array.from(document.querySelectorAll<HTMLInputElement>(".hist-item__check"));
const control = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".history-selection button")).find((n) => n.textContent?.trim() === text)!;
const turnsPill = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Turns"] .history-filter__pill')).find((b) => (b.childNodes[0]?.textContent ?? "").trim() === label)!;
const countText = () => document.querySelector(".history-selection__count")?.textContent ?? "";
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";

// 1. one checkbox per ordinary trashed row; system recovery data has none
assert.equal(checks().length, 3, "ordinary rows get a checkbox, system recovery data does not");

// 2. checking a row toggles the count and never loads a preview
const previewsBefore = previewCalls;
await act(async () => checks()[0].click());
assert.equal(countText(), "1 selected");
await act(async () => checks()[1].click());
assert.equal(countText(), "2 selected", "each checkbox toggles independently");
assert.equal(previewCalls, previewsBefore, "checking a row must not trigger the preview load");
await act(async () => checks()[1].click());
assert.equal(countText(), "1 selected", "unchecking removes the row from the selection");

// 3. a checked row that a filter hides stops counting; a filter can only ever
//    narrow the bulk action, never widen it beyond what is visible
await act(async () => checks()[2].click());          // c: 9 turns
assert.equal(countText(), "2 selected");
await act(async () => turnsPill("1 turn").click());  // hides c
assert.equal(checks().length, 2, "the 1-turn filter hides the 9-turn row");
assert.equal(countText(), "1 selected", "a row filtered out of view drops out of the count");
await act(async () => control("Select all").click());
assert.equal(countText(), "2 selected", "select all covers exactly the visible rows");

// 4. bulk purge confirms, then fans out through the same per-path callback
await act(async () => control("Delete selected").click());
assert.ok(dialogText().includes("2 selected conversations"), "bulk purge confirms the visible selection count");
assert.ok(!dialogText().includes("including filtered-out"), "bulk purge must not claim it deletes hidden rows");
await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((n) => n.textContent?.trim() === "Confirm deletion")!.click());
assert.deepEqual(calls, ["purge:a", "purge:b"], "bulk purge reuses the per-path purge callback and stays inside the selection");
assert.equal(sessions.some((s) => s.path === "c"), true, "a row outside the selection is untouched");
assert.equal(sessions.some((s) => s.path === "protected"), true, "system recovery data is never selected or purged");

// 5. bulk restore is the same single-row callback, without a confirmation dialog
await act(async () => turnsPill("All").click());
assert.equal(checks().length, 1, "only the remaining ordinary row is selectable");
assert.equal(countText(), "1 selected", "a still-checked row stays checked once it becomes visible again");
await act(async () => control("Restore selected").click());
assert.deepEqual(calls, ["purge:a", "purge:b", "restore:c"], "bulk restore reuses the per-path restore callback");
assert.equal(document.querySelector('[role="dialog"]'), null, "restore needs no confirmation");

await act(async () => root.unmount());
dom.window.close();
console.log("PASS trash bulk actions: per-row checkboxes, visible-scoped select-all, confirm+fanned purge, fanned restore");