// The running sub-agent strip above the composer.
//
// The transcript cannot answer "is anything still working?" — a running
// sub-agent sits inside a fold that may be collapsed or scrolled away — so the
// strip states it where the reader already looks. It reads the persisted run
// sidecars only (see useSubagentRuns), which is why a live run, a background
// run, and a session switch all produce the same line, and why a finished run
// drops off on its own.
//
// Each entry is the backend's precomputed label: "<name>: <content>", clipped
// to a fixed width at dispatch. The strip never composes a label itself, so it
// cannot show one string here and a different one after a session switch.

import { useEffect, useState } from "react";

import "./SubagentRunningStrip.css";
import { useT } from "../lib/i18n";
import { splitSubagentLabel } from "../lib/subagentInventory";
import { subagentRunIsRunning } from "../lib/useSubagentRuns";
import type { SubagentRunView } from "../lib/types";

/** How many distinct runs the strip names before collapsing to a count. */
const NAMED_LIMIT = 6;

function elapsedLabel(fromIso: string, now: number): string | undefined {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return undefined;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function SubagentRunningStrip({ runs }: { runs: readonly SubagentRunView[] }) {
  const t = useT();
  const running = runs.filter(subagentRunIsRunning);
  const [now, setNow] = useState(() => Date.now());
  // Tick only while something runs, so an idle strip costs nothing.
  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running.length]);

  if (running.length === 0) return null;
  const named = running.slice(0, NAMED_LIMIT);
  const extra = running.length - named.length;

  return (
    <div className="subagent-strip" role="status" aria-live="polite">
      <span className="subagent-strip__pulse" aria-hidden="true" />
      <span className="subagent-strip__count">{t("subagent.strip.running", { n: running.length })}</span>
      {named.map((run) => {
        const { tool, content } = splitSubagentLabel(run.label);
        return (
          <span key={run.ref} className="subagent-strip__name" title={run.label}>
            <span className="subagent-strip__tool">{tool || "sub-agent"}</span>
            {content && <span className="subagent-strip__subject">{content}</span>}
            <em className="subagent-strip__time">{elapsedLabel(run.createdAt, now) ?? ""}</em>
          </span>
        );
      })}
      {extra > 0 && <span className="subagent-strip__more">{t("subagent.strip.more", { n: extra })}</span>}
    </div>
  );
}
