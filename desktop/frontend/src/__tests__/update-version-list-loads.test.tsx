// Run: tsx src/__tests__/update-version-list-loads.test.tsx

// The version list is metadata: loading it must not be swallowed by a check or
// a focus refresh running in the same panel, and a stale answer must not
// overwrite a newer one. It also keeps its own error state so a failed catalog
// fetch can be retried without touching the update check.

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppBindings } from "../lib/bridge";
import { UpdaterProvider, useUpdater } from "../lib/useUpdater";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;

const versions = [
  "v1.38.54-beta.4",
  "v1.38.54-beta.3",
  "v1.38.54-beta.2",
  "v1.38.54-beta.1",
  "v1.38.53",
  "v1.38.52",
  "v1.38.51",
];
const catalog = {
  current: versions[0],
  canSelfUpdate: true,
  installMode: "portable",
  entries: versions.map((version, index) => ({
    version,
    channel: version.includes("beta") ? "beta" : "stable",
    publishedAt: "2026-10-16T12:41:11Z",
    current: index === 0,
    installable: index !== 0,
    manifestUrl: "",
  })),
};

let checkDeferred = false;
let listDeferred = false;
let listFails = false;
let listCalls = 0;
let resolveCheck: ((value: unknown) => void) | null = null;
let resolveList: ((value: unknown) => void) | null = null;

window.go = {
  main: {
    App: {
      CheckUpdate() {
        if (!checkDeferred) return Promise.resolve(null);
        return new Promise((resolve) => {
          resolveCheck = resolve;
        });
      },
      ListUpdateVersions() {
        listCalls += 1;
        if (listFails) return Promise.reject(new Error("catalog unavailable"));
        if (!listDeferred) return Promise.resolve(catalog);
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      },
    } as unknown as AppBindings,
  },
} as unknown as typeof window.go;

function Probe({ id }: { id: string }) {
  const { status, check, versions: loaded, versionsLoading, versionsError, listVersions } = useUpdater();
  return (
    <section>
      <output id={`${id}-status`}>{status.kind}</output>
      <output id={`${id}-versions`}>{loaded ? String(loaded.entries.length) : "null"}</output>
      <output id={`${id}-loading`}>{versionsLoading ? "loading" : ""}</output>
      <output id={`${id}-error`}>{versionsError}</output>
      <button id={`${id}-check`} type="button" onClick={() => void check()}>check</button>
      <button id={`${id}-list`} type="button" onClick={() => void listVersions()}>list</button>
    </section>
  );
}

const root = createRoot(document.getElementById("root")!);
let mount = 0;

async function render() {
  mount += 1;
  await act(async () => {
    root.render(
      <UpdaterProvider key={String(mount)}>
        <Probe id="banner" />
        <Probe id="settings" />
      </UpdaterProvider>,
    );
  });
}

async function click(id: string) {
  await act(async () => {
    (document.getElementById(id) as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const text = (id: string) => document.getElementById(id)?.textContent ?? "";

// A check in flight used to make the list request return early without a trace.
checkDeferred = true;
listDeferred = false;
listFails = false;
listCalls = 0;
await render();
await click("banner-check");
ok(text("banner-status") === "checking", "a slow check owns the busy status");
await click("settings-list");
ok(listCalls === 1, "the list request still reaches the bridge while a check is in flight");
ok(text("settings-versions") === "7", "the panel receives the full 7-entry union");
ok(text("settings-status") === "checking", "loading the list leaves the check status alone");
await act(async () => {
  resolveCheck?.(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
ok(text("banner-status") === "upToDate", "the check publishes its own result");
ok(text("settings-versions") === "7", "the list survives the check that finished afterwards");

// A check started after the list request used to discard the list answer.
checkDeferred = true;
listDeferred = true;
listCalls = 0;
await render();
await click("settings-list");
ok(listCalls === 1, "the list request is in flight");
await click("banner-check");
ok(text("banner-status") === "checking", "a later check starts while the list is pending");
await act(async () => {
  resolveList?.(catalog);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
ok(text("settings-versions") === "7", "the returned list is published instead of being dropped as stale");

// A failed catalog fetch is reported on its own and can be retried.
checkDeferred = false;
listDeferred = false;
listFails = true;
listCalls = 0;
await render();
await click("settings-list");
ok(text("settings-versions") === "null", "a failed fetch publishes no rows");
ok(text("settings-error").includes("catalog unavailable"), "the failure is reported as a list error");
ok(text("settings-status") === "idle", "a list failure does not turn into an update error");
listFails = false;
await click("settings-list");
ok(text("settings-versions") === "7", "retrying after a failure loads the list");
ok(text("settings-error") === "", "a successful retry clears the error");
ok(listCalls === 2, "the retry issues a second request");

// Superseded answers never overwrite a newer list.
const stale = { ...catalog, entries: catalog.entries.slice(0, 1) };
listDeferred = true;
listCalls = 0;
await render();
await click("settings-list");
const firstResolve = resolveList;
listDeferred = false;
await click("settings-list");
ok(text("settings-versions") === "7", "the newer request publishes its answer");
await act(async () => {
  firstResolve?.(stale);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
ok(text("settings-versions") === "7", "the superseded answer cannot replace the newer list");
ok(text("settings-loading") === "", "the list leaves its loading state");

delete window.go;

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);