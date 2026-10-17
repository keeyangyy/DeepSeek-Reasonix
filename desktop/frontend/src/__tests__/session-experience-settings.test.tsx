import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionExperienceSettings } from "../components/SessionExperienceSettings";
import { LocaleProvider } from "../lib/i18n";
import { getSessionExperience } from "../lib/sessionExperience";
import { getReasoningExpansionPolicy } from "../lib/reasoningExpansionPolicy";
import { getProcessFoldPolicy } from "../lib/processFoldPolicy";
import type { SettingsView } from "../lib/types";

const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let backend: SettingsView = { sessionExperience: "standard" } as SettingsView;
let release!: () => void;
let failed = false;
const writes: string[] = [];
Object.assign(window, { go: { main: { App: { SetSessionExperience: async (mode: string) => {
  writes.push(mode);
  await new Promise<void>(resolve => { release = resolve; });
  if (failed) throw new Error("write failed");
  backend = { ...backend, sessionExperience: mode as "deep" | "standard" };
} } } } });
let completion: Promise<boolean>;
let reload!: () => void;
function SettingsHost() {
  const [snapshot, setSnapshot] = useState(backend);
  const [busy, setBusy] = useState(false);
  reload = () => setSnapshot({ ...backend });
  // Exercise the component's shared apply/reload boundary, not a guessed rollback.
  const apply = (write: () => Promise<unknown>) => {
    setBusy(true);
    completion = (async () => {
      try { await write(); return true; } catch { return false; }
      finally { reload(); setBusy(false); }
    })();
    return completion;
  };
  return <SessionExperienceSettings snapshot={snapshot} busy={busy} apply={apply} />;
}
const root = createRoot(document.getElementById("root")!);
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[role=radio]")];
try {
  await act(async () => root.render(<LocaleProvider><SettingsHost /></LocaleProvider>));
  assert.equal(buttons().length, 9, "standard/deep, the three expansion policies and the four process-fold policies");
  assert.equal(buttons()[0].getAttribute("aria-checked"), "true");
  await act(async () => buttons()[1].click());
  assert.equal(getSessionExperience(), "deep");
  assert.ok(buttons().every(button => button.disabled));
  await act(async () => { release(); await completion; });
  assert.equal(buttons()[1].getAttribute("aria-checked"), "true");

  failed = true;
  await act(async () => buttons()[0].click());
  assert.equal(getSessionExperience(), "standard");
  await act(async () => { release(); await completion; });
  assert.equal(getSessionExperience(), "deep", "failed write reloads even when backend returns the same previous value");
  assert.equal(buttons()[1].getAttribute("aria-checked"), "true");
  assert.deepEqual(writes, ["deep", "standard"]);

  // Both inner-item controls are inert while Deep is active: Deep already
  // keeps work expanded, so the choice cannot be changed and the stored
  // default stays untouched. Buttons 2-4 are all-collapsed / latest-only /
  // all-expanded, and 5-8 are collapsed / active-only / follow-turn /
  // always-expanded.
  assert.equal(getReasoningExpansionPolicy(), "latest-only");
  assert.equal(buttons()[3].getAttribute("aria-checked"), "true", "latest-only is the default for a fresh install");
  assert.equal(getProcessFoldPolicy(), "follow-turn");
  assert.equal(buttons()[7].getAttribute("aria-checked"), "true", "follow-turn stays the default");
  assert.ok(buttons().slice(2).every(button => button.disabled), "Deep disables both inner-item controls");

  backend = { ...backend, sessionExperience: undefined };
  await act(async () => reload());
  assert.equal(getSessionExperience(), "standard");
  assert.equal(buttons()[0].getAttribute("aria-checked"), "true");

  // The expansion policy is a local three-state preference: clicking its
  // buttons changes the stored value without touching the backend contract.
  await act(async () => buttons()[2].click());
  assert.equal(getReasoningExpansionPolicy(), "all-collapsed");
  assert.equal(buttons()[2].getAttribute("aria-checked"), "true");
  await act(async () => buttons()[3].click());
  assert.equal(getReasoningExpansionPolicy(), "latest-only");
  await act(async () => buttons()[4].click());
  assert.equal(getReasoningExpansionPolicy(), "all-expanded");
  assert.equal(buttons()[4].getAttribute("aria-checked"), "true");

  // Process folding follows the same shape: a local four-mode policy that
  // never widens the backend contract either.
  await act(async () => buttons()[5].click());
  assert.equal(getProcessFoldPolicy(), "collapsed");
  assert.equal(buttons()[5].getAttribute("aria-checked"), "true");
  await act(async () => buttons()[6].click());
  assert.equal(getProcessFoldPolicy(), "active-only");
  assert.equal(buttons()[6].getAttribute("aria-checked"), "true");
  await act(async () => buttons()[8].click());
  assert.equal(getProcessFoldPolicy(), "always-expanded");
  assert.equal(buttons()[8].getAttribute("aria-checked"), "true");
  await act(async () => buttons()[7].click());
  assert.equal(getProcessFoldPolicy(), "follow-turn");
  assert.equal(buttons()[7].getAttribute("aria-checked"), "true");
  assert.deepEqual(writes, ["deep", "standard"], "neither local preference ever reaches the backend");
  assert.equal(buttons()[0].tabIndex, 0, "both segment buttons remain keyboard reachable");
  assert.equal(buttons()[1].tabIndex, 0);
  assert.equal(buttons()[5].disabled, false, "leaving Deep re-enables the fold policy choice");
  assert.equal(buttons()[2].disabled, false, "leaving Deep re-enables the expansion policy choice");
  console.log("session experience controls: success, failure snapshot, busy state, legacy backend, expansion policy, fold policy and keyboard reachability passed");
} finally { await act(async () => root.unmount()); dom.window.close(); }
