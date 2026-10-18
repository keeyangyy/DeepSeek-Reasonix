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

function action(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".prompt-action")]
    .find((item) => item.textContent?.includes(label));
  assert.ok(button, `option ${label} exists`);
  return button;
}

function entry(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(".ask-shelf__entry-group input");
  assert.ok(field, "the shared entry input exists");
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
const click = async (button: HTMLButtonElement) => act(async () => button.click());

// One shared input is sent with a normal option as a prefixed answer item, and
// a single-select choice still advances immediately.
await render({
  id: "ask-note-single",
  questions: [
    { id: "single", prompt: "Choose", options: [{ label: "A" }, { label: "B" }] },
    { id: "later", prompt: "Next", options: [{ label: "Done" }] },
  ],
});
await act(async () => setText(entry(), "  because  "));
await click(action("A"));
assert.equal(progress(), "Question 2/2", "single choice advances immediately after carrying the note");
await click(back());
assert.equal(entry().value, "  because  ", "Back restores the shared input draft");
await click(action("A"));
await click(action("Done"));
assert.equal(submitted.length, 0, "a click on the final question waits for the confirm action");
await click(confirm());
assert.deepEqual(submitted.at(-1), [
  { questionId: "single", selected: ["A", "补充：because"] },
  { questionId: "later", selected: ["Done"] },
]);
console.log("  PASS  shared supplement is prefixed, single-select advances mid-ask and confirms on the last");

// Multi-select keeps its existing explicit-confirm flow; one supplement applies
// once to the whole group, rather than creating one input per selected option.
await render({
  id: "ask-note-multi",
  questions: [{ id: "multi", prompt: "Pick any", multi: true, options: [{ label: "Red" }, { label: "Blue" }] }],
});
assert.equal(confirm().disabled, true, "an empty multi-select is not answered");
await click(action("Red"));
await click(action("Blue"));
assert.equal(document.querySelectorAll(".ask-shelf__entry-group input").length, 1, "multi-select still has only one input");
await act(async () => setText(entry(), "warm"));
await click(confirm());
assert.deepEqual(submitted.at(-1), [{ questionId: "multi", selected: ["Red", "Blue", "补充：warm"] }]);
console.log("  PASS  multi-select choices and one shared supplement submit together");

// Other is an option: for single-select a click marks its current text and the
// last question waits for the explicit confirm; an empty click shows a prompt and
// leaves the same input ready for typing.
await render({
  id: "ask-other-single",
  questions: [{ id: "choice", prompt: "Choose or write", options: [{ label: "Suggested" }] }],
});
const beforeEmptyOther = submitted.length;
await click(action("Other"));
assert.equal(submitted.length, beforeEmptyOther, "empty Other does not submit");
assert.ok(document.querySelector('[role="alert"]')?.textContent, "empty Other explains that an answer is required");
await act(async () => setText(entry(), "my own answer"));
const beforeOtherMark = submitted.length;
await click(action("Other"));
assert.equal(submitted.length, beforeOtherMark, "clicking Other marks the custom answer without submitting");
await click(confirm());
assert.deepEqual(submitted.at(-1), [{ questionId: "choice", selected: ["my own answer"] }]);
console.log("  PASS  Other marks the shared input for confirm and validates empty input");

// In multi-select, Other remains an alternative answer that uses the normal
// explicit confirm action instead of submitting from a row click.
await render({
  id: "ask-other-multi",
  questions: [{ id: "choice", prompt: "Pick or write", multi: true, options: [{ label: "Suggested" }] }],
});
await act(async () => setText(entry(), "custom multi answer"));
const beforeMultiOther = submitted.length;
await click(action("Other"));
assert.equal(submitted.length, beforeMultiOther, "multi-select Other preserves explicit confirmation");
await click(confirm());
assert.deepEqual(submitted.at(-1), [{ questionId: "choice", selected: ["custom multi answer"] }]);
console.log("  PASS  multi-select Other uses the existing confirm flow");

// Enter confirms a selected answer, while Enter used by an active IME does not.
await render({
  id: "ask-note-ime",
  questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Yes" }] }],
});
await act(async () => setText(entry(), "confirmed by Enter"));
const input = entry();
await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true, isComposing: true,
})));
assert.equal(submitted.at(-1)?.[0]?.questionId, "choice", "IME Enter does not submit");
const beforeEnter = submitted.length;
await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
  key: "Enter", bubbles: true, cancelable: true,
})));
assert.equal(submitted.length, beforeEnter + 1, "ordinary Enter confirms the highlighted answer");
assert.deepEqual(submitted.at(-1), [{ questionId: "choice", selected: ["Yes", "补充：confirmed by Enter"] }]);
console.log("  PASS  shared input Enter confirms and respects IME composition");

await act(async () => root.unmount());
dom.window.close();
