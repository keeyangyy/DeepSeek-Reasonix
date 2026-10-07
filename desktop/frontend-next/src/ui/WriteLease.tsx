import { useEffect, useState } from "react";
import { t } from "../i18n";
import { reason } from "../i18n/kernel";
import { Group } from "./Group";
import { arrowRadios } from "./tablist";
import type { AgentPort, WriteLeaseSettings } from "../port/port";

// One choice over how far the cross-session write lease reaches. The key is the
// user's alone — a project file cannot widen or remove the protection — so the
// row reads the user file and shows the mode that answer produces.
const MODES = ["strict", "optimistic", "off"] as const;

const MODE_NAME: Record<string, string> = {
  strict: "严格",
  optimistic: "乐观",
  off: "关闭写锁",
};

const MODE_WHY: Record<string, string> = {
  strict: "凡是可能重叠的写者都排队，与上游一致——包括没声明 write_paths 的子代理。",
  optimistic: "只让声明了写入路径的写者互斥；说不清范围的写者（bash、MCP、没声明 write_paths 的子代理）不再占住整个工作区。",
  off: "本会话不取跨会话写锁：不再排住别的会话，也不再被它们排住。会话内子代理之间仍按声明路径与写者名额（max_parallel_writers）排队。",
};

export function WriteLease({ port, onChanged }: { port: AgentPort; onChanged: () => void }) {
  const [state, setState] = useState<WriteLeaseSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    port
      .writeLease()
      .then(setState)
      .catch(() => setState(null));
  }, [port]);

  if (!state) return <div className="empty">{t("无法读取写锁档位。")}</div>;

  const pick = async (mode: string) => {
    if (mode === state.mode) return;
    setBusy(true);
    setError("");
    try {
      setState(await port.saveWriteLease(mode));
      onChanged();
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="box">
      <div className="lrow">
        <span className="tx">
          <span className="lb">{t("写锁档位")}</span>
          <span className="ds">{t(MODE_WHY[state.mode] ?? MODE_WHY.strict)}</span>
        </span>
        <div className="seg" data-text role="radiogroup" aria-label={t("写锁档位")} data-action-keydown="write-lease.mode" onKeyDown={arrowRadios}>
          {MODES.map((mode) => (
            <button
              key={mode}
              role="radio"
              data-action="write-lease.mode"
              data-value={mode}
              aria-checked={state.mode === mode}
              tabIndex={state.mode === mode ? 0 : -1}
              disabled={busy}
              onClick={() => void pick(mode)}
            >
              {t(MODE_NAME[mode])}
            </button>
          ))}
        </div>
      </div>
      {state.effective !== state.mode && (
        <div className="kv">
          <span className="k">{t("实际生效")}</span>
          <span className="v">{t(MODE_WHY[state.effective] ?? MODE_WHY.strict)}</span>
        </div>
      )}
      {error && <div className="why">{error}</div>}
    </div>
  );
}

// The settings block ships whole so the settings page keeps one line for it
// instead of a frame plus its wording; that also keeps that upstream file from
// growing past its line ceiling for a fork-only row.
export function WriteLeaseGroup({ port, onChanged }: { port: AgentPort; onChanged: () => void }) {
  return (
    <Group
      id="write-lease"
      title={t("写锁档位")}
      hint={t("跨会话写锁走多远：严格＝凡是可能重叠的写者都排队（上游行为）；乐观＝只让声明了写入路径的写者互斥，说不清范围的写者不再占住整个工作区；关闭写锁＝本会话不取跨会话写锁，会话内子代理之间仍按写者名额与声明路径排队。修改会重建运行时，任务运行期间无法变更。")}
    >
      <WriteLease port={port} onChanged={onChanged} />
    </Group>
  );
}
