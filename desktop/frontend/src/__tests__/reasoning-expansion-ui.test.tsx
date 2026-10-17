// Run: tsx src/__tests__/reasoning-expansion-ui.test.tsx
//
// UI regression for the three-state reasoning expansion policy, driven through
// the real virtual row model:
//   all-collapsed — every reasoning block folds to its one-line summary.
//   latest-only   — only the newest reasoning block of the session opens; an
//                   older turn's last block is NOT the newest one, and the
//                   newest block stays open once the generation ends.
//   all-expanded  — every block opens.
//
// "Newest" comes from the row model's global ordering, never from a block's
// own `streaming` flag, and a manual toggle is never overwritten by streaming
// token updates. The Deep experience outranks the policy entirely.
//
// The harness installs process-wide globals (jsdom window, localStorage), so
// the policy phases run SEQUENTIALLY inside one harness, switching the policy
// through the store's setter exactly like the settings page does.

import { createTranscriptHarness, type TranscriptHarness } from "./transcript-dom-harness";
import type { Item } from "../lib/useController";
import { act } from "react";

let passed = 0;
let failed = 0;

function ok(value: unknown, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

console.log("\nreasoning expansion ui");

const harness = await createTranscriptHarness();
const { container } = harness;
const { setReasoningExpansionPolicy } = await harness.loadModule<{
  setReasoningExpansionPolicy: (policy: "all-collapsed" | "latest-only" | "all-expanded") => void;
}>("/src/lib/reasoningExpansionPolicy.ts");
const { applySessionExperience } = await harness.loadModule<{
  applySessionExperience: (value: "standard" | "deep") => void;
}>("/src/lib/sessionExperience.ts");

/** Text of every OPENED reasoning block, in document order. */
function openReasoningTexts(): string[] {
  return Array.from(container.querySelectorAll(".turn-collapse__reasoning-phase--open"))
    .map((element) => element.textContent ?? "");
}

/** True when exactly one block is open and it contains `text`. */
function onlyOpen(text: string): boolean {
  const open = openReasoningTexts();
  return open.length === 1 && open[0].includes(text);
}

function openCount(): number {
  return openReasoningTexts().length;
}

// A multi-turn history with tool calls interleaved between the thinking
// blocks. Every assistant item carries reasoning only, so each turn is a
// single work-process segment that stays open.
const history: Item[] = [
  { kind: "user", id: "u1", text: "inspect" },
  { kind: "assistant", id: "a1", text: "", reasoning: "first thought", streaming: false },
  { kind: "tool", id: "t1", name: "read_file", args: "{}", readOnly: true, status: "done", durationMs: 400 },
  { kind: "assistant", id: "a2", text: "", reasoning: "second thought", streaming: false },
  { kind: "tool", id: "t2", name: "bash", args: "{}", readOnly: false, status: "done", durationMs: 600 },
  { kind: "user", id: "u2", text: "and again" },
  { kind: "assistant", id: "a3", text: "", reasoning: "third thought", streaming: false },
];

try {
  // ── latest-only: only the newest block of the whole session opens ──────────
  await act(async () => { setReasoningExpansionPolicy("latest-only"); });
  await harness.render(history);
  ok(onlyOpen("third thought"), "latest-only opens only the newest reasoning block of the session");
  ok(!openReasoningTexts().some((text) => text.includes("second thought")), "an older turn's last block is not mistaken for the newest one");
  ok(container.querySelectorAll(".turn-collapse__reasoning-phase").length === 3, "all three reasoning blocks render");

  // ── all-collapsed folds everything ────────────────────────────────────────
  await act(async () => { setReasoningExpansionPolicy("all-collapsed"); });
  await harness.render(history);
  ok(openCount() === 0, "all-collapsed folds every reasoning block");
  ok(container.querySelectorAll(".reasoning-summary").length === 3, "every folded block keeps its one-line summary");

  // ── all-expanded opens everything ─────────────────────────────────────────
  await act(async () => { setReasoningExpansionPolicy("all-expanded"); });
  await harness.render(history);
  ok(openCount() === 3, "all-expanded opens every reasoning block");

  // ── switching back re-applies the policy to blocks already on screen ──────
  await act(async () => { setReasoningExpansionPolicy("all-collapsed"); });
  await harness.render(history);
  ok(openCount() === 0, "switching to all-collapsed folds blocks already on screen");
  await act(async () => { setReasoningExpansionPolicy("latest-only"); });
  await harness.render(history);
  ok(onlyOpen("third thought"), "switching back to latest-only re-opens only the newest block");

  // ── live streaming: the producing block opens, older ones fold ────────────
  const streaming: Item[] = [
    { kind: "user", id: "u1", text: "inspect" },
    { kind: "assistant", id: "a1", text: "", reasoning: "first thought", streaming: false },
    { kind: "tool", id: "t1", name: "read_file", args: "{}", readOnly: true, status: "done", durationMs: 400 },
    { kind: "assistant", id: "a2", text: "", reasoning: "second thought", streaming: true, reasoningComplete: false },
  ];
  await act(async () => { setReasoningExpansionPolicy("latest-only"); });
  await harness.render(streaming, {
    running: true,
    live: { id: "a2", text: "", reasoning: "second thought", reasoningComplete: false },
  });
  ok(onlyOpen("second thought"), "the block the live stream feeds is the one that opens");
  ok(!openReasoningTexts().some((text) => text.includes("first thought")), "an earlier block folds while a newer one streams");

  // ── generation ends: the newest block stays open ──────────────────────────
  await harness.render(streaming, {
    running: false,
    live: { id: "a2", text: "", reasoning: "second thought", reasoningComplete: true },
  });
  ok(onlyOpen("second thought"), "the newest block stays open after the generation ends");

  // ── a manual toggle is not overwritten by streaming updates ───────────────
  await harness.render(streaming, {
    running: true,
    live: { id: "a2", text: "", reasoning: "second thought", reasoningComplete: false },
  });
  const heads = Array.from(container.querySelectorAll<HTMLButtonElement>(".turn-collapse__reasoning-head"));
  ok(heads.length === 2, "two reasoning headers are rendered while streaming");
  // Fold the open (newest) block by hand, then push more tokens: the manual
  // choice must survive every streaming frame.
  const openHead = heads.find((head) => head.getAttribute("aria-expanded") === "true");
  ok(Boolean(openHead), "the newest block starts open while streaming");
  await act(async () => {
    openHead?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  ok(openCount() === 0, "a manual fold closes the streaming block");
  for (let token = 0; token < 5; token += 1) {
    await harness.render(streaming, {
      running: true,
      live: { id: "a2", text: "", reasoning: `second thought ${"x".repeat(token + 1)}`, reasoningComplete: false },
    });
  }
  ok(openCount() === 0, "streaming token updates never reopen a manually folded block");
  // And a manual expansion survives too.
  await act(async () => {
    const folded = Array.from(container.querySelectorAll<HTMLButtonElement>(".turn-collapse__reasoning-head"))
      .find((head) => head.getAttribute("aria-expanded") === "false");
    folded?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let token = 0; token < 5; token += 1) {
    await harness.render(streaming, {
      running: true,
      live: { id: "a2", text: "", reasoning: `second thought ${"y".repeat(token + 1)}`, reasoningComplete: false },
    });
  }
  ok(openCount() === 1, "a manual expansion survives streaming token updates");

  // ── Deep outranks the policy ──────────────────────────────────────────────
  await act(async () => { setReasoningExpansionPolicy("all-collapsed"); });
  await act(async () => { applySessionExperience("deep"); });
  await harness.render(history);
  ok(openCount() === 3, "the Deep experience keeps every block expanded regardless of the collapsed policy");

  // A manual collapse still wins inside Deep.
  await act(async () => {
    const head = container.querySelector<HTMLButtonElement>(".turn-collapse__reasoning-head");
    head?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  ok(openCount() === 2, "a manual collapse still wins inside the Deep experience");

  await act(async () => { applySessionExperience("standard"); });
} finally {
  await harness.unmount();
  await harness.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
