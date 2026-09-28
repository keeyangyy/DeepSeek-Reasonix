// A one-line status strip above the composer while sub-agents are running.
//
// The transcript cannot answer "is anything still working?" — a running
// sub-agent sits inside a fold that may be collapsed and scrolled away — so the
// panel's own inventory is surfaced where the reader already looks: next to the
// composer. The strip exists only while work is in flight and disappears on its
// own, so it never competes with a settled conversation.

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { summarizeSubagents, type SubagentEntry } from "../lib/subagentInventory";

/** How many distinct runs the strip names before collapsing to a count. */
const NAMED_LIMIT = 2;

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** The running entries of the forest, flattened in dispatch order. */
function runningEntries(forest: readonly SubagentEntry[]): SubagentEntry[] {
  const out: SubagentEntry[] = [];
  const walk = (entries: readonly SubagentEntry[]) => {
    for (const entry of entries) {
      if (entry.running) out.push(entry);
      walk(entry.children);
    }
  };
  walk(forest);
  return out;
}

export function SubagentRunningStrip({
  forest,
  onOpen,
}: {
  /** The session's sub-agent forest (the panel's own projection). */
  forest: readonly SubagentEntry[];
  onOpen: () => void;
}) {
  const t = useT();
  const summary = summarizeSubagents(forest);
  const [tick, setTick] = useState(0);
  // Tick only while something runs, so an idle strip costs nothing.
  useEffect(() => {
    if (summary.running === 0) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [summary.running]);
  void tick;

  if (summary.running === 0) return null;
  const running = runningEntries(forest);
  const named = running.slice(0, NAMED_LIMIT);
  const extra = running.length - named.length;

  return (
    <button
      type="button"
      className="subagent-strip"
      onClick={onOpen}
      aria-label={t("subagent.panel.title")}
    >
      <span className="subagent-strip__pulse" aria-hidden="true" />
      <span className="subagent-strip__count">{t("subagent.strip.running", { n: summary.running })}</span>
      {named.map((entry) => (
        <span key={entry.id} className="subagent-strip__name">
          {entry.subject || entry.name}
          {entry.durationMs !== undefined && <em className="subagent-strip__time">{elapsedLabel(entry.durationMs)}</em>}
        </span>
      ))}
      {extra > 0 && <span className="subagent-strip__more">{t("subagent.strip.more", { n: extra })}</span>}
      <span className="subagent-strip__open">{t("subagent.strip.open")}</span>
    </button>
  );
}
