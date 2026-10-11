import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { QuestionAnswer, WireAsk } from "../lib/types";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AskCard } = await import("../components/AskCard");
const { LocaleProvider } = await import("../lib/i18n");
const root = createRoot(document.getElementById("root")!);
const submitted: QuestionAnswer[][] = [];

async function render(ask: WireAsk) {
  await act(async () => root.render(
    <LocaleProvider>
      <AskCard ask={ask} draftScope="ask-supplement-test" onAnswer={(_id, answers) => { submitted.push(answers); }} onStop={() => undefined} />
    </LocaleProvider>,
  ));
}

function option(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".prompt-action")]
    .find((item) => item.textContent?.includes(label));
  assert.ok(button, `option ${label} exists`);
  return button;
}

function input(label: string): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(field, `input ${label} exists`);
  return field;
}

function setText(field: HTMLInputElement, value: string) {
  const propsKey = Object.keys(field).find((key) => key.startsWith("__reactProps"));
  const props = propsKey ? (field as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[propsKey] : undefined;
  assert.ok(props?.onChange, "React input handler exists");
  props.onChange({ target: { value } });
}

const confirm = () => document.querySelector<HTMLButtonElement>(".decision-confirm-bar__confirm")!;
const back = () => document.querySelector<HTMLButtonElement>(".ask-shelf__pager-button")!;
const progress = () => document.querySelector(".ask-shelf__header-text--progress")?.textContent ?? "";

// Single choice waits for confirmation; its note survives Back and is sent
// after the option as a separate Selected value.
await render({
  id: "ask-note-single",
  questions: [
    { id: "single", prompt: "Choose", options: [{ label: "A" }, { label: "B" }] },
    { id: "later", prompt: "Next", options: [{ label: "Done" }] },
  ],
});
await act(async () => option("A").click());
assert.equal(progress(), "Question 1/2", "single choice remains on the current question for its optional note");
await act(async () => setText(input("Additional note for A"), "  because  "));
await act(async () => confirm().click());
assert.equal(progress(), "Question 2/2", "Confirm advances after a single choice and note");
await act(async () => back().click());
assert.equal(input("Additional note for A").value, "  because  ", "Back restores the per-choice note draft");
await act(async () => confirm().click());
await act(async () => option("Done").click());
await act(async () => confirm().click());
assert.deepEqual(submitted.at(-1), [
  { questionId: "single", selected: ["A", "because"] },
  { questionId: "later", selected: ["Done"] },
]);
console.log("  PASS  single-select note, explicit advance, trim, and Back restoration");

// Each checked multi-select choice owns an independent optional note.
await render({
  id: "ask-note-multi",
  questions: [{ id: "multi", prompt: "Pick any", multi: true, options: [{ label: "Red" }, { label: "Blue" }] }],
});
assert.equal(confirm().disabled, true, "an empty multi-select is not answered");
await act(async () => option("Red").click());
await act(async () => option("Blue").click());
await act(async () => setText(input("Additional note for Red"), "warm"));
await act(async () => setText(input("Additional note for Blue"), "cool"));
await act(async () => confirm().click());
assert.deepEqual(submitted.at(-1), [{ questionId: "multi", selected: ["Red", "warm", "Blue", "cool"] }]);
console.log("  PASS  multiple selections each carry their own note");

// Notes cannot answer a question without a selected option.
await render({
  id: "ask-note-only",
  questions: [{ id: "multi", prompt: "Pick any", multi: true, options: [{ label: "Only" }] }],
});
assert.equal(confirm().disabled, true, "a note cannot be entered without selecting a choice");
await act(async () => option("Only").click());
await act(async () => setText(input("Additional note for Only"), "note only"));
await act(async () => option("Only").click());
assert.equal(confirm().disabled, true, "deselecting the option leaves the note insufficient to answer");
assert.equal(submitted.at(-1)?.[0]?.questionId, "multi", "note-only state has not submitted another answer");
console.log("  PASS  a supplement alone does not count as an answer");

// Custom answer remains an alternative, excluding both selected options and notes.
await render({
  id: "ask-note-custom",
  questions: [{ id: "choice", prompt: "Choose or write", options: [{ label: "Suggested" }] }],
});
await act(async () => option("Suggested").click());
await act(async () => setText(input("Additional note for Suggested"), "ignored note"));
await act(async () => document.querySelector<HTMLElement>(".ask-shelf__custom-row")!.click());
await act(async () => setText(input("Other answer"), "custom answer"));
await act(async () => confirm().click());
assert.deepEqual(submitted.at(-1), [{ questionId: "choice", selected: ["custom answer"] }]);
console.log("  PASS  custom answer replaces options and their notes");

await render({
  id: "ask-note-custom-ime",
  questions: [{ id: "choice", prompt: "Write", options: [{ label: "Suggested" }] }],
});
await act(async () => document.querySelector<HTMLElement>(".ask-shelf__custom-row")!.click());
const customInput = input("Other answer");
await act(async () => setText(customInput, "custom confirmed by Enter"));
const beforeCustomIME = submitted.length;
await act(async () => customInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true, isComposing: true,
})));
assert.equal(submitted.length, beforeCustomIME, "IME Enter does not submit a custom answer");
await act(async () => customInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true,
})));
assert.equal(submitted.length, beforeCustomIME + 1, "ordinary Enter submits a custom answer");
console.log("  PASS  custom-answer Enter also respects IME composition");

// Enter confirms the selected answer, while Enter used by an active IME does not.
await render({
  id: "ask-note-ime",
  questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Yes" }] }],
});
await act(async () => option("Yes").click());
const noteInput = input("Additional note for Yes");
await act(async () => setText(noteInput, "confirmed by Enter"));
await act(async () => noteInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true, isComposing: true,
})));
assert.equal(submitted.at(-1)?.[0]?.questionId, "choice", "IME Enter has not submitted the new Ask");
const beforeEnter = submitted.length;
await act(async () => noteInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true,
})));
assert.equal(submitted.length, beforeEnter + 1, "ordinary Enter confirms the answer");
assert.deepEqual(submitted.at(-1), [{ questionId: "choice", selected: ["Yes", "confirmed by Enter"] }]);
console.log("  PASS  Enter confirms and IME Enter does not submit");

await act(async () => root.unmount());
dom.window.close();
