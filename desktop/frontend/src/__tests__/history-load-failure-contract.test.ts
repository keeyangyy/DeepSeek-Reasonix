// Run: npx tsx src/__tests__/history-load-failure-contract.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverRefusedClear } from "../lib/clearSessionRecovery";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const controller = readFileSync(join(root, "lib/useController.ts"), "utf8");
const store = readFileSync(join(root, "lib/transcriptStore.ts"), "utf8");
const chatPane = readFileSync(join(root, "app-shell/ChatPaneRegion.tsx"), "utf8");
const appView = readFileSync(join(root, "app-shell/AppRuntimeView.tsx"), "utf8");

assert.match(controller, /deferResetUntilHistory \?\? true/, "history reset waits for successful load");
assert.match(controller, /type: "hydrate_error"/, "history failure dispatches hydrate_error");
assert.match(controller, /applyHydrateErrorState|hydratePlaceholderItems/, "hydrate_error keeps previous content");
assert.match(readFileSync(join(root, "lib/hydrateErrorState.ts"), "utf8"), /keptItems/, "hydrateErrorState preserves items");
assert.match(controller, /throw new Error\(t\("history\.failedLoadHistory"\)\)/, "listSessions does not swallow failures as empty");
assert.match(controller, /retrySessionHistory/, "retry path is exported");
assert.match(controller, /shouldPreferResidentHistory\(resetSurface, options\.preserveCachedHistory\)/, "retry hydrates fetch instead of serving the resident snapshot");
assert.match(
  controller,
  /return\s+await\s+recoverRefusedClear\(tabId,\s*refreshMetaForTab,\s*loadSessionDataForTab,\s*err\)/,
  "failed clear recovery remains wired into the controller",
);
assert.match(store, /slice\.error/, "transcript store rejects slice.error as failure");
assert.match(appView, /retrySessionHistory/, "App wires history retry control");
assert.match(chatPane, /history-load-error/, "App surfaces hydrate error banner");

const originalError = new Error("clear refused");
const recoveryCalls: unknown[][] = [];
await assert.rejects(
  recoverRefusedClear(
    "target-tab",
    async (tabId) => { recoveryCalls.push(["refresh", tabId]); },
    async (tabId, reset, reason, options) => {
      recoveryCalls.push(["reload", tabId, reset, reason, options]);
    },
    originalError,
  ),
  (error) => error === originalError,
  "refused clear rethrows the original failure after recovery",
);
assert.deepEqual(
  recoveryCalls,
  [
    ["refresh", "target-tab"],
    ["reload", "target-tab", false, "startup", { preserveCachedHistory: true }],
  ],
  "refused clear refreshes metadata before reloading the same tab without reset and keeps cached history",
);

console.log("  PASS  history load failure contract");
