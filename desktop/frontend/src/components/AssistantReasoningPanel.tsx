import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useWorkProcessPresentation } from "../lib/sessionExperience";
import { useReasoningExpansionPolicy } from "../lib/reasoningExpansionPolicy";
import {
  defaultReasoningExpansionOpen,
  expansionPreferenceChanged,
  reconcileReasoningExpansion,
  type ReasoningExpansionInput,
} from "../lib/reasoningExpansionState";
import { useCollapseAnimation } from "../lib/useCollapseAnimation";
import { useT } from "../lib/i18n";
import type { Item } from "../lib/useController";
import { Markdown } from "./Markdown";
import { ProcessBrainIcon } from "./ProcessCard";
import { ReasoningSummary } from "./ReasoningSummary";
import { StreamingReasoningText } from "./StreamingReasoningText";

type AssistantItem = Extract<Item, { kind: "assistant" }>;

function reasoningDurationLabel(durationMs: number | undefined, t: ReturnType<typeof useT>): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return t("msg.thinkingDone");
  return t("msg.thinkingDuration", { s: Math.max(1, Math.round(durationMs / 1000)) });
}

export function AssistantReasoningPanel({
  item,
  defaultExpanded,
  expandWhileStreaming,
}: {
  item: AssistantItem;
  defaultExpanded: boolean;
  expandWhileStreaming: boolean;
}) {
  const t = useT();
  const presentation = useWorkProcessPresentation();
  const policy = useReasoningExpansionPolicy();
  const running = item.streaming && !item.reasoningComplete;
  const followsWhileStreaming = presentation.showWhileRunning || expandWhileStreaming;
  const keepExpanded = presentation.keepExpandedAfterCompletion;
  const expansion: ReasoningExpansionInput = {
    experience: presentation.experience,
    policy,
    // "Producing" here means THE TURN IS STILL RUNNING, not "this block's
    // reasoning phase is unfinished": while the answer streams after the
    // reasoning finished, the work process is still live and must stay open
    // (the historical showWhileRunning contract). `item.streaming` is the
    // turn-level liveness flag, which is a legitimate input for this panel.
    //
    // `isLatest` is a different fact and is deliberately NOT claimed here:
    // it is a session-wide ordering fact only the row model can answer, and
    // self-reporting it would keep every completed block open under
    // "newest only". This panel has no row-model context, so it reports false
    // and lets the turn-level producing flag carry the streaming behavior.
    producing: item.streaming && followsWhileStreaming,
    isLatest: false,
    // `defaultExpanded` is the caller's "keep this panel open regardless"
    // request. It maps onto the keep-expanded signal the state machine already
    // understands, so it keeps its old meaning: never auto-close, never
    // substitute the one-line summary.
    keepExpandedAfterCompletion: keepExpanded || defaultExpanded,
    showWhileRunning: followsWhileStreaming,
  };
  const [open, setOpen] = useState(() => defaultReasoningExpansionOpen(expansion));
  const bodyRef = useRef<HTMLDivElement>(null);
  const userOverridden = useRef(false);
  const previousStreaming = useRef(item.streaming);
  const previousPreference = useRef({ experience: presentation.experience, policy });

  useEffect(() => {
    const wasStreaming = previousStreaming.current;
    const preferenceChanged = expansionPreferenceChanged(previousPreference.current, { experience: presentation.experience, policy });
    previousStreaming.current = item.streaming;
    previousPreference.current = { experience: presentation.experience, policy };
    if (preferenceChanged) {
      // A preference or experience switch re-applies the defaults and drops
      // manual choices so the panel lands in one consistent state.
      userOverridden.current = false;
      setOpen(defaultReasoningExpansionOpen(expansion));
      return;
    }
    if (item.streaming && !wasStreaming) userOverridden.current = false;
    // A manual toggle outranks the policy for as long as the preference stays.
    if (userOverridden.current) return;
    const next = reconcileReasoningExpansion(
      { open, userOverridden: false, wasProducing: wasStreaming, wasLatest: true },
      expansion,
    );
    if (next.open !== open) setOpen(next.open);
  }, [expansion, item.streaming, open, policy, presentation.experience]);

  const toggle = () => {
    userOverridden.current = true;
    setOpen((value) => !value);
  };
  useCollapseAnimation(bodyRef, open);
  const meta = running ? "" : reasoningDurationLabel(item.reasoningDurationMs, t);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning__head" data-running={running ? "" : undefined} onClick={toggle} aria-expanded={open}>
        <ProcessBrainIcon size={12} />
        <span data-creation-label={t("creation.reasoningLabel")}>{running ? t("msg.thinkingRunning") : t("msg.thinking")}</span>
        {meta && <span className="reasoning__meta">{meta}</span>}
        <ChevronRight className={`reasoning__chevron${open ? " reasoning__chevron--open" : ""}`} size={12} />
      </button>
      {open ? (
        <div ref={bodyRef} className="reasoning__body" data-transcript-selectable="reasoning" data-nested-scroll>
          {running
            ? <StreamingReasoningText text={item.reasoning} />
            : <Markdown text={item.reasoning} streaming={false} cacheKey={item.id} wasStreamed={item.wasStreamed} />}
        </div>
      ) : (
        <ReasoningSummary text={item.reasoning} streaming={running} onOpen={toggle} />
      )}
    </div>
  );
}
