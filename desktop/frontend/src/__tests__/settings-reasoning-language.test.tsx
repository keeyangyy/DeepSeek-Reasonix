// Run: node --import ./scripts/css-stub-register.mjs --import ./scripts/svg-stub-register.mjs --import tsx src/__tests__/settings-reasoning-language.test.tsx

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SettingsPanel } from "../components/SettingsPanel";
import { LocaleProvider } from "../lib/i18n";
import type { AppBindings } from "../lib/bridge";
import type { SettingsView } from "../lib/types";
import { baseSettings, flushPromises, installCanvasMock } from "../test-support/settingsTestFixtures";

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}

console.log("\nsettings thinking language");

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
installCanvasMock(dom.window as unknown as Window);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
window.scrollTo = () => {};
localStorage.clear();

let settings: SettingsView = baseSettings("standard");
settings.defaultModel = "reasoning-provider/reasoning-model";
settings.providers = [{
  name: "reasoning-provider",
  builtIn: false,
  added: true,
  kind: "openai",
  baseUrl: "https://reasoning.example.com/v1",
  chatUrl: "",
  models: ["reasoning-model"],
  visionModels: [],
  visionModelsConfigured: false,
  modelsUrl: "",
  default: "reasoning-model",
  apiKeyEnv: "",
  keySet: false,
  requiresKey: false,
  configured: true,
  balanceUrl: "",
  contextWindow: 100_000,
  reasoningProtocol: "",
  thinking: "",
  supportedEfforts: [],
  defaultEffort: "",
  modelOverrides: [],
}];
const calls: string[] = [];
window.go = {
  main: {
    App: {
      Settings: async () => settings,
      FetchAllProviderModelCatalogs: async () => ({}),
      SetReasoningLanguage: async (lang: string) => {
        calls.push(lang);
        settings = { ...settings, agent: { ...settings.agent, reasoningLanguage: lang } };
      },
    } as Partial<AppBindings> as AppBindings,
  },
};

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

await act(async () => {
  root.render(
    <LocaleProvider>
      <SettingsPanel initialTab="models" desktopPlatform="linux" onClose={() => {}} onChanged={() => {}} />
    </LocaleProvider>,
  );
  await flushPromises();
});

function options(): HTMLButtonElement[] {
  return Array.from(
    rootEl.querySelectorAll('[role="radiogroup"][aria-label="Thinking language"] [role="radio"]'),
  ) as HTMLButtonElement[];
}

const initial = options();
eq(initial.length, 4, "thinking language exposes four choices");
eq(
  initial.map((option) => option.textContent?.trim()).join("|"),
  "Auto|中文|English|No injection",
  "choices are auto, Chinese, English and no injection",
);
eq(
  initial.map((option) => option.getAttribute("aria-checked")).join("|"),
  "true|false|false|false",
  "auto is selected by default",
);

await act(async () => {
  initial[3].click();
  await flushPromises();
});

eq(calls.join(","), "off", "choosing no injection persists off rather than auto");
eq(settings.agent.reasoningLanguage, "off", "saved snapshot keeps off");
eq(options()[3]?.getAttribute("aria-checked"), "true", "persisted off stays selected after reload");

await act(async () => {
  root.unmount();
});
dom.window.close();

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
