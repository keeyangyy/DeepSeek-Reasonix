import "./SubagentDetails.css";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ResizableDrawer } from "./ResizableDrawer";
import { ModalCloseButton } from "./ModalCloseButton";
import { Markdown } from "./Markdown";
import { ReasoningSummary } from "./ReasoningSummary";
import { SubagentOutcomeCard } from "./SubagentOutcomeCard";
import { useT, type Translator } from "../lib/i18n";
import type { Item, SubagentPhase } from "../lib/useController";
import { buildSubagentForest, splitSubagentsByActivity, summarizeSubagents, type SubagentEntry } from "../lib/subagentInventory";
import type { SubagentRunView } from "../lib/subagentRunsBridge";

// The panel answers "what did this session delegate to sub-agents?" without
// requiring the reader to expand a settled turn's fold. It lists the same
// entries the transcript nests, and previews the live progress the transcript
// only shows inline while the parent call is open.

function phaseLabel(t: Translator, phase: SubagentPhase | undefined, running: boolean): string {
  switch (phase) {
    case "queued": return t("subagent.phase.queued");
    case "running": return t("subagent.phase.running");
    case "reasoning": return t("subagent.phase.reasoning");
    case "responding": return t("subagent.phase.responding");
    case "tool": return t("subagent.phase.tool");
    case "retrying": return t("subagent.phase.retrying");
    case "completed": return t("subagent.phase.completed");
    case "partial": return t("subagent.phase.partial");
    case "failed": return t("subagent.phase.failed");
    case "cancelled": return t("subagent.phase.cancelled");
    // Hydrated calls carry no phase: say so rather than claiming a live state.
    default: return running ? t("subagent.phase.running") : t("subagent.panel.unknownPhase");
  }
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * A short, stable tag for a folded row.
 *
 * Most dispatches carry no subject, so every folded line would read "task" and
 * a long panel becomes a column of identical rows. The id's tail is the one
 * piece that always differs (a run sidecar's ref, or the call id), which is
 * enough to tell two rows apart without expanding either.
 */
function shortTag(id: string): string {
  const tail = id.replace(/[^A-Za-z0-9]+/g, "");
  return tail.length > 8 ? tail.slice(-8) : tail;
}

function SubagentRow({ entry, depth }: { entry: SubagentEntry; depth: number }) {
  const t = useT();
  // Every row starts folded. A long fan-out is unreadable expanded, and the
  // header line already carries what a reader scans for (name, state, time);
  // expanding is the deliberate act of inspecting one run.
  const [open, setOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const progress = entry.progress;
  const title = entry.subject || entry.name;

  return (
    <div className="subagent-panel__row" data-running={entry.running ? "1" : undefined} style={{ paddingLeft: `${depth * 14}px` }}>
      <div className="subagent-panel__head">
        <button
          type="button"
          className="subagent-panel__toggle"
          aria-expanded={open}
          aria-label={t("subagent.panel.toggle")}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={`subagent-panel__chevron${open ? " subagent-panel__chevron--open" : ""}`} size={12} />
        </button>
        <button type="button" className="subagent-panel__title" onClick={() => setOpen((value) => !value)}>
          <span className="subagent-panel__name">{title}</span>
          {!entry.subject && <span className="subagent-panel__tag">{shortTag(entry.id)}</span>}
        </button>
        <span className={`subagent-panel__phase${entry.running ? " subagent-panel__phase--running" : ""}`}>
          {phaseLabel(t, entry.phase, entry.running)}
        </span>
        {entry.durationMs !== undefined && <span className="subagent-panel__duration">{elapsedLabel(entry.durationMs)}</span>}
      </div>

      {/*
        A container (fleet / parallel_tasks) always shows the calls it fanned
        out: the tree's shape is the list's skeleton, not a detail. Only the
        row's own detail — meta, outcome, previews — sits behind the toggle,
        which is what keeps a long panel scannable.
      */}
      {(open || entry.children.length > 0) && (
        <div className="subagent-panel__body">
          {open && (
            <>
              <div className="subagent-panel__meta">
                <code>{entry.name}</code>
                {entry.profile?.model && <span>{entry.profile.model}</span>}
                {entry.profile?.effort && <span>{entry.profile.effort}</span>}
              </div>
              {entry.outcome && <SubagentOutcomeCard outcome={entry.outcome} />}
              {progress?.reasoning && (
                <div className="tool__subagent-preview-section">
                  <button
                    type="button"
                    className="tool__subagent-preview-label tool__subagent-preview-label--toggle"
                    aria-expanded={reasoningOpen}
                    onClick={() => setReasoningOpen((value) => !value)}
                  >
                    {t("subagent.preview.reasoning")}
                  </button>
                  {reasoningOpen
                    ? <div className="tool__subagent-preview-text tool__subagent-preview-text--markdown"><Markdown text={progress.reasoning} streaming={progress.phase === "reasoning"} /></div>
                    : <ReasoningSummary text={progress.reasoning} streaming={progress.phase === "reasoning"} onOpen={() => setReasoningOpen(true)} />}
                </div>
              )}
              {progress?.text && (
                <div className="tool__subagent-preview-section">
                  <div className="tool__subagent-preview-label">{t("subagent.preview.text")}</div>
                  <pre className="tool__subagent-preview-text">{progress.text}</pre>
                </div>
              )}
              {progress?.notice && (
                <div className="tool__subagent-preview-section">
                  <div className="tool__subagent-preview-label">{t("subagent.preview.notice")}</div>
                  <pre className="tool__subagent-preview-text">{progress.notice}</pre>
                </div>
              )}
              {!progress && !entry.outcome && <div className="subagent-panel__note">{t("subagent.panel.noPreview")}</div>}
            </>
          )}
          {entry.children.length > 0 && (
            <div className="subagent-panel__children">
              {entry.children.map((child) => <SubagentRow key={child.id} entry={child} depth={depth + 1} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SubagentPanel({
  items,
  runs,
  onClose,
  onOpenTranscript,
}: {
  /** The session's transcript items (the same list the transcript renders). */
  items: readonly Item[];
  /** Persisted run sidecars: the nesting/outcome a rebuilt session lost. */
  runs?: readonly SubagentRunView[];
  onClose: () => void;
  onOpenTranscript?: () => void;
}) {
  const t = useT();
  const forest = useMemo(() => buildSubagentForest(items, runs ?? []), [items, runs]);
  const summary = useMemo(() => summarizeSubagents(forest), [forest]);
  // Running work first: it is the only part that needs watching, and the
  // settled history below stays folded to one line per run.
  const groups = useMemo(() => splitSubagentsByActivity(forest), [forest]);
  const [tick, setTick] = useState(0);
  // Elapsed time of running entries: tick only while something is in flight.
  useEffect(() => {
    if (summary.running === 0) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [summary.running]);
  void tick;

  return (
    <ResizableDrawer onClose={onClose} subtle>
      <header className="drawer__head">
        <div>
          <div className="drawer__title">{t("subagent.panel.title")}</div>
          <div className="drawer__summary">
            {summary.total === 0
              ? t("subagent.panel.emptySummary")
              : t("subagent.panel.summary", { total: summary.total, running: summary.running })}
          </div>
        </div>
        <div className="drawer__actions">
          <ModalCloseButton label={t("common.close")} onClick={onClose} />
        </div>
      </header>
      <div className="drawer__body">
        {summary.total === 0 ? (
          <div className="subagent-panel__empty">
            <div>{t("subagent.panel.empty")}</div>
            {onOpenTranscript && (
              <button type="button" className="chip" onClick={onOpenTranscript}>{t("subagent.panel.backToTranscript")}</button>
            )}
          </div>
        ) : (
          <div className="subagent-panel__list">
            {groups.active.length > 0 && (
              <section className="subagent-panel__group" aria-label={t("subagent.panel.groupRunning")}>
                <div className="subagent-panel__group-title">{t("subagent.panel.groupRunning")}</div>
                {groups.active.map((entry) => <SubagentRow key={entry.id} entry={entry} depth={0} />)}
              </section>
            )}
            {groups.settled.length > 0 && (
              <section className="subagent-panel__group" aria-label={t("subagent.panel.groupSettled")}>
                <div className="subagent-panel__group-title">{t("subagent.panel.groupSettled")}</div>
                {groups.settled.map((entry) => <SubagentRow key={entry.id} entry={entry} depth={0} />)}
              </section>
            )}
          </div>
        )}
      </div>
    </ResizableDrawer>
  );
}
