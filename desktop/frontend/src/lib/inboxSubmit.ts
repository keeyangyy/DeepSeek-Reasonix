import type { AppBindings } from "./bridge";
import type { StructuredInvocationSubmit } from "./invocationDisplay";
import { asArray } from "./array";
import type { QuestionAnswer } from "./types";

type InboxEnqueueBindings = Pick<AppBindings, "EnqueueInboxFollowup" | "EnqueueInboxFollowupWithInvocations" | "EnqueueInboxSteer" | "EnqueueInboxSteerForTurn">;
type ActiveTurnBindings = Pick<AppBindings, "ListTabs" | "SteerInboxItem" | "SteerInboxItemForTurn">;

export async function resolveActiveTurnId(binding: Pick<AppBindings, "ListTabs">, tabId: string, _known?: string): Promise<string | undefined> {
  // The cached id can outlive the controller turn during startup, recovery,
  // or a runtime rebuild. Always refresh from the tab owner before crossing
  // the exact-turn answer/steer boundary; the optional value is only a hint
  // for callers that have not received local state yet.
  const authoritative = asArray(await binding.ListTabs()).find((tab) => tab.id === tabId)?.turnId;
  return authoritative;
}

type AskAnswerBindings = Pick<AppBindings, "ListTabs" | "ResolvePromptForTab">;

export async function resolvePromptForTab(
  binding: Pick<AppBindings, "ListTabs" | "ResolvePromptForTab">,
  tabId: string,
  promptId: string,
  kind: string,
  answer: Record<string, unknown>,
  knownTurnId?: string,
  knownRuntimeEpoch?: string,
): Promise<void> {
  const submit = await import("./exactPromptSubmit");
  return submit.resolvePromptForTab(binding, tabId, promptId, kind, answer, knownTurnId, knownRuntimeEpoch);
}

// Final frontend boundary before optimistic transcript state is created.
export function normalizeTurnSubmit(displayText: string, submitText: string) {
  const display = displayText.trim();
  const submit = submitText.trim();
  if (!submit) throw new Error("Message cannot be empty.");
  return { display, submit };
}

export async function answerPromptForActiveTurn(
  binding: AskAnswerBindings,
  tabId: string,
  promptId: string,
  answers: QuestionAnswer[],
  knownTurnId?: string,
  knownRuntimeEpoch?: string,
): Promise<void> {
  await resolvePromptForTab(binding, tabId, promptId, "ask", { questions: answers }, knownTurnId, knownRuntimeEpoch);
}

export async function steerInboxItemForActiveTurn(binding: ActiveTurnBindings, tabId: string, itemId: string, knownTurnId?: string) {
  if (typeof binding.SteerInboxItemForTurn !== "function") return binding.SteerInboxItem(tabId, itemId);
  const turnId = await resolveActiveTurnId(binding, tabId, knownTurnId);
  if (!turnId) throw new Error("active turn id is unavailable; refresh and try again");
  return binding.SteerInboxItemForTurn(tabId, turnId, itemId);
}

export async function enqueueInboxGuidanceForActiveTurn(
  binding: InboxEnqueueBindings & Pick<AppBindings, "ListTabs">,
  tabId: string,
  display: string,
  submit: string,
  structured?: StructuredInvocationSubmit,
  knownTurnId?: string,
  preferQueue?: boolean,
) {
  const needsTurnId = !structured && !preferQueue && typeof binding.EnqueueInboxSteerForTurn === "function";
  const turnId = needsTurnId ? await resolveActiveTurnId(binding, tabId, knownTurnId) : knownTurnId;
  // A steer can only be admitted while a turn is running. Without one the row
  // has nowhere to go this turn, so it becomes a next-turn follow-up instead of
  // failing the submit the user just made. Hosts that predate the exact-turn
  // binding keep the legacy EnqueueInboxSteer path, which needs no turn id.
  // preferQueue skips admission entirely: the user asked for the next turn.
  const steer = !preferQueue && (!needsTurnId || Boolean(turnId));
  return enqueueInboxGuidance(binding, tabId, display, submit, structured, { steer, turnId });
}

export function enqueueInboxGuidance(
  binding: InboxEnqueueBindings,
  tabId: string,
  display: string,
  submit: string,
  structured?: StructuredInvocationSubmit,
  opts?: { steer?: boolean; turnId?: string },
) {
  if (structured) {
    // Commands and skill entities always queue, whatever the interjection
    // target says. They need their own turn: a running turn has already fixed
    // its input, and the steer channel carries text only, so steering would
    // drop the entity. Guarded by composer-guidance-target.test.tsx.
    return binding.EnqueueInboxFollowupWithInvocations(
      tabId,
      structured.display.trim() || display,
      structured.input.trim(),
      structured.invocations,
      "",
    );
  }
  if (opts?.steer && typeof binding.EnqueueInboxSteer === "function") {
    if (typeof binding.EnqueueInboxSteerForTurn === "function") {
      if (!opts.turnId) return Promise.reject(new Error("active turn id is unavailable; refresh and try again"));
      return binding.EnqueueInboxSteerForTurn(tabId, opts.turnId, display, submit || display, "");
    }
    return binding.EnqueueInboxSteer(tabId, display, submit || display, "");
  }
  return binding.EnqueueInboxFollowup(tabId, display, submit || display, "");
}
