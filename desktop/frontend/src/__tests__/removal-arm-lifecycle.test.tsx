import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The pending permanent delete must be a live intent, not a leftover flag: a press
// outside the owning row releases it, a press inside does not, switching targets
// re-arms, and leaving it sitting releases it. Without these, a stray first click
// would let a much later single click delete for good.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/", pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRemovalArm, REMOVAL_ARM_MS } = await import("../lib/removalArm");

type Arm = {
  isArmed: (key: string) => boolean;
  disarm: () => void;
  confirm: (key: string, run: () => void) => void;
};

let latest: Arm | null = null;
const runs: string[] = [];

function Probe() {
  const value = useRemovalArm(".project-tree__topic-actions");
  latest = value as Arm;
  return React.createElement("div", null,
    React.createElement("span", { className: "project-tree__topic-actions" },
      React.createElement("button", { id: "inside" }, "inside")),
    React.createElement("button", { id: "outside" }, "outside"));
}

// isArmed closes over the armed key, so every read must take the newest render.
const arm = () => {
  if (!latest) throw new Error("probe did not render");
  return latest;
};

const root = createRoot(document.getElementById("root")!);
await act(async () => { root.render(React.createElement(Probe)); });

async function press(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing ${id}`);
  await act(async () => {
    node.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
async function armKey(key: string) {
  await act(async () => { arm().confirm(key, () => runs.push(key)); });
}

// A first click arms and runs nothing; the second click on the same target runs it.
await armKey("a");
assert.equal(arm().isArmed("a"), true, "the first activation arms the target");
assert.deepEqual(runs, [], "the first activation does not run the delete");
await armKey("a");
assert.deepEqual(runs, ["a"], "the second activation runs the delete once");
assert.equal(arm().isArmed("a"), false, "running clears the arm");

// Another target takes the arm, and an explicit release drops it.
await armKey("b");
await armKey("c");
assert.equal(arm().isArmed("c"), true, "the newest target owns the arm");
assert.equal(arm().isArmed("b"), false, "an earlier target cannot keep it");
await act(async () => { arm().disarm(); });
assert.equal(arm().isArmed("c"), false, "disarm releases the pending delete");

// A press on the row that owns the pending delete keeps it; a press elsewhere does
// not, which is what makes "click away and come back" a fresh two-click intent.
await armKey("d");
await press("inside");
assert.equal(arm().isArmed("d"), true, "a press inside the owning row keeps the arm");
await press("outside");
assert.equal(arm().isArmed("d"), false, "a press outside the owning row releases the arm");
assert.deepEqual(runs, ["a"], "a released arm never runs the delete later");

// Leaving it sitting releases it too, so a slow user is never confirmed by accident.
assert.equal(typeof REMOVAL_ARM_MS, "number", "the arm has a bounded lifetime");
const scheduled: Array<{ callback: () => void; delay: number }> = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, delay?: number) => {
  scheduled.push({ callback, delay: delay ?? 0 });
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
try {
  await armKey("e");
  const release = scheduled.filter((entry) => entry.delay === REMOVAL_ARM_MS);
  assert.equal(release.length, 1, "arming schedules exactly one release");
  assert.equal(arm().isArmed("e"), true, "the delete is pending before the timeout");
  await act(async () => { for (const entry of release) entry.callback(); });
  assert.equal(arm().isArmed("e"), false, "an untouched arm releases itself");
  assert.deepEqual(runs, ["a"], "a self-released arm never runs the delete");
} finally {
  globalThis.setTimeout = realSetTimeout;
}

await act(async () => { root.unmount(); });
dom.window.close();
console.log("removal arm lifecycle: 5 passed");
