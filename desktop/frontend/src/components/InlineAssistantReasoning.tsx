import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useWorkProcessPresentation } from "../lib/sessionExperience";
import { useReasoningExpansionPolicy } from "../lib/reasoningExpansionPolicy";
import {
  defaultReasoningExpansionOpen,
  expansionPreferenceChanged,
  reconcileReasoningExpansion,
  type ReasoningExpansionInput,
} from "../lib/reasoningExpansionState";
import type { AssistantItem } from "../lib/transcriptRows";
import { useT } from "../lib/i18n";
import { LiveStreamContext } from "./LiveStreamContext";
import { Markdown } from "./Markdown";
import { ProcessBrainIcon } from "./ProcessCard";
import { ReasoningSummary } from "./ReasoningSummary";
import { StreamingReasoningText } from "./StreamingReasoningText";
import { useTranscriptUserResizeIntent } from "./TranscriptLayoutIntentContext";
import { resolveReasoningLayoutVariant } from "../lib/transcriptRowGeometry";
import { useReasoningScrollFollow } from "../lib/useReasoningScrollFollow";

export function InlineAssistantReasoning({
  item,
  autoFollowActive,
  isLatestReasoning,
  onManualOpen,
}: {
  item: AssistantItem;
  autoFollowActive?: boolean;
  /** Set by the row model: this is the newest reasoning block of the session. */
  isLatestReasoning?: boolean;
  onManualOpen?: () => void;
}) {
  const t = useT();
  const beginUserResize = useTranscriptUserResizeIntent();
  const live = useContext(LiveStreamContext);
  const presentation = useWorkProcessPresentation();
  const policy = useReasoningExpansionPolicy();
  // live 拥有这一行，但只有当它确实带着 reasoning 内容时才接管正文：切会话 /
  // 历史页接管的那一瞬 live 可能还是空的，而 item 上已落盘的内容才是用户该看到
  // 的那份。原先无条件以 live 为准，于是折叠头按 item.reasoning 报了「1 段思考」，
  // 正文却因 live.reasoning 为空走到下面的 return null，整块消失。
  const liveFeedsReasoning = live?.id === item.id && Boolean(live.reasoning);
  const shown = liveFeedsReasoning
    ? { reasoning: live!.reasoning, streaming: true, reasoningComplete: live!.reasoningComplete }
    : item;
  const running = shown.streaming && !shown.reasoningComplete;
  const followActive = autoFollowActive ?? shown.streaming;
  // "This block is the one streaming right now" is an OWNERSHIP fact: the live
  // stream names the item it feeds. The component's own `streaming` flag alone
  // cannot separate a live block from one that stopped but was not cleared yet,
  // and it cannot see whether a newer block has taken over.
  const producing = liveFeedsReasoning && !live!.reasoningComplete;
  // Which block is the newest comes from the row model's global ordering, so a
  // block inside a multi-segment turn knows it is no longer the latest one.
  const isLatest = isLatestReasoning ?? false;
  const expansion: ReasoningExpansionInput = {
    experience: presentation.experience,
    policy,
    producing,
    isLatest,
    keepExpandedAfterCompletion: presentation.keepExpandedAfterCompletion,
    showWhileRunning: presentation.showWhileRunning,
  };
  const [open, setOpen] = useState(() => defaultReasoningExpansionOpen(expansion));
  const userOverridden = useRef(false);
  const previousProducing = useRef(producing);
  const previousLatest = useRef(isLatest);
  const previousPreference = useRef({ experience: presentation.experience, policy });
  useEffect(() => {
    const preferenceChanged = expansionPreferenceChanged(previousPreference.current, { experience: presentation.experience, policy });
    previousPreference.current = { experience: presentation.experience, policy };
    const wasProducing = previousProducing.current;
    const wasLatest = previousLatest.current;
    previousProducing.current = producing;
    previousLatest.current = isLatest;
    if (preferenceChanged) {
      // A preference or experience switch re-applies the defaults across the
      // transcript and drops manual choices, so everything lands in one state.
      userOverridden.current = false;
      setOpen(defaultReasoningExpansionOpen(expansion));
      return;
    }
    if (producing && !wasProducing) {
      // A new thinking block just took over: open it and forget an earlier
      // manual choice on THIS block. Older blocks fold because the model marks
      // only the newest one — no token-driven churn is involved.
      userOverridden.current = false;
    }
    // A manual toggle outranks the policy for as long as the preference stays.
    if (userOverridden.current) return;
    const next = reconcileReasoningExpansion({ open, userOverridden: false, wasProducing, wasLatest }, expansion);
    if (next.open !== open) setOpen(next.open);
  }, [expansion, isLatest, open, policy, producing, presentation.experience, presentation.keepExpandedAfterCompletion, presentation.showWhileRunning]);
  const toggle = useCallback(() => {
    beginUserResize();
    userOverridden.current = true;
    if (!open) onManualOpen?.();
    setOpen(!open);
  }, [beginUserResize, onManualOpen, open]);
  const reasoning = shown.reasoning.trim();
  const [reasoningScrollRef, onReasoningScroll] = useReasoningScrollFollow(shown.reasoning, open && running);
  if (!reasoning) return null;
  const layoutVariant = open
    ? "reasoning-expanded"
    : resolveReasoningLayoutVariant(presentation.keepExpandedAfterCompletion ? "expanded" : "summary", followActive) ?? "reasoning-heading-only";
  return (
    <div
      className={`turn-collapse__reasoning-phase${open ? " turn-collapse__reasoning-phase--open" : ""}`}
      data-transcript-layout-variant={layoutVariant}
    >
      <button type="button" className="turn-collapse__reasoning-head" data-running={running ? "" : undefined} onClick={toggle} aria-expanded={open}>
        <ProcessBrainIcon size={12} />
        <span>{running ? t("msg.thinkingRunning") : t("msg.thinking")}</span>
        <ChevronRight className={`reasoning__chevron${open ? " reasoning__chevron--open" : ""}`} size={12} />
      </button>
      {open ? (
        <div
          ref={reasoningScrollRef}
          className="turn-collapse__inline-reasoning reasoning__body"
          data-transcript-selectable="reasoning"
          data-nested-scroll
          onScroll={onReasoningScroll}
        >
          {running
            ? <StreamingReasoningText text={shown.reasoning} />
            : <Markdown text={shown.reasoning} streaming={false} cacheKey={item.id} wasStreamed={item.wasStreamed} />}
        </div>
      ) : (
        <ReasoningSummary text={shown.reasoning} streaming={running} onOpen={toggle} />
      )}
    </div>
  );
}
