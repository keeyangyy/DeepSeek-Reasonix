// Run: tsx src/__tests__/inbox-submit-target.test.ts

import type { AppBindings } from "../lib/bridge";
import { enqueueInboxGuidanceForActiveTurn } from "../lib/inboxSubmit";
import type { TabMeta } from "../lib/types";

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

function binding(overrides: Partial<AppBindings>): AppBindings {
  return overrides as AppBindings;
}

// A host that records which enqueue path the submit took. Only the methods this
// module touches are present, so a fallthrough to the wrong one shows up as a
// missing call rather than a silent success.
function recorder(turnId: string | undefined) {
  const calls: string[] = [];
  const tabs = [{ id: "tab-1", turnId } as TabMeta];
  return {
    calls,
    bindings: binding({
      ListTabs: async () => tabs,
      EnqueueInboxFollowup: async (_tab, display) => {
        calls.push(`followup:${display}`);
        return { itemId: "i", disposition: "queued_followup", position: 1, paused: false };
      },
      EnqueueInboxFollowupWithInvocations: async (_tab, display) => {
        calls.push(`followup-invocations:${display}`);
        return { itemId: "i", disposition: "queued_followup", position: 1, paused: false };
      },
      EnqueueInboxSteer: async (_tab, display) => {
        calls.push(`steer:${display}`);
        return { itemId: "i", disposition: "steer_accepted", position: 1, paused: false };
      },
      EnqueueInboxSteerForTurn: async (_tab, turn, display) => {
        calls.push(`steer-turn:${turn}:${display}`);
        return { itemId: "i", disposition: "steer_accepted", position: 1, paused: false };
      },
    }),
  };
}

console.log("\nInbox submit target selection");

// A running turn accepts the steer, which is the default the composer now aims
// for: guidance joins the turn the user is watching.
{
  const rec = recorder("turn-live");
  await enqueueInboxGuidanceForActiveTurn(rec.bindings, "tab-1", "hello", "hello");
  eq(rec.calls.join("|"), "steer-turn:turn-live:hello", "a running turn receives the guidance as a steer");
}

// No turn means nowhere to steer. The submit must still land, as a next-turn
// follow-up, instead of rejecting the message the user just wrote.
{
  const rec = recorder(undefined);
  await enqueueInboxGuidanceForActiveTurn(rec.bindings, "tab-1", "hello", "hello");
  eq(rec.calls.join("|"), "followup:hello", "an idle session falls back to the next-turn queue");
}

// Structured invocations always run as their own turn; steering cannot carry them.
{
  const rec = recorder("turn-live");
  await enqueueInboxGuidanceForActiveTurn(rec.bindings, "tab-1", "display", "input", {
    display: "display",
    input: "input",
    invocations: [],
  } as never);
  eq(rec.calls.join("|"), "followup-invocations:display", "structured submits bypass steering");
}

// Older hosts have no exact-turn binding. They keep the legacy steer call, which
// needs no turn id, rather than degrading to a follow-up.
{
  const calls: string[] = [];
  const legacy = binding({
    ListTabs: async () => [{ id: "tab-1", turnId: undefined } as TabMeta],
    EnqueueInboxFollowup: async (_tab, display) => {
      calls.push(`followup:${display}`);
      return { itemId: "i", disposition: "queued_followup", position: 1, paused: false };
    },
    EnqueueInboxSteer: async (_tab, display) => {
      calls.push(`steer:${display}`);
      return { itemId: "i", disposition: "steer_accepted", position: 1, paused: false };
    },
  });
  await enqueueInboxGuidanceForActiveTurn(legacy, "tab-1", "hello", "hello");
  eq(calls.join("|"), "steer:hello", "a host without the exact-turn binding keeps the legacy steer path");
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
