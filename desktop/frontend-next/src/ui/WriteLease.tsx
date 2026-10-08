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
  strict: "声明了 write_paths 的写者按路径互斥；未声明路径的写者（bash、MCP、未获 write_paths 的子代理）占用整个工作区，因而与其他写者一律互斥。",
  optimistic: "仅声明了 write_paths 的写者按路径互斥；未声明路径的写者不再占用整个工作区，可与其他会话并行。",
  off: "本会话不取跨会话写锁：既不阻塞其他会话，也不被其阻塞。会话内子代理仍按声明路径与写者名额（max_parallel_writers）排队。",
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
// instead of a frame plus its wording; that also keeps Settings.tsx from
// growing past its line ceiling for one more row.
export function WriteLeaseGroup({ port, onChanged }: { port: AgentPort; onChanged: () => void }) {
  return (
    <Group
      id="write-lease"
      title={t("写锁档位")}
      hint={t("跨会话写锁的适用范围：严格＝声明了 write_paths 的写者按路径互斥，未声明路径的写者占用整个工作区；乐观＝仅声明了 write_paths 的写者按路径互斥，未声明路径的写者不占用工作区；关闭写锁＝本会话不取跨会话写锁。会话内子代理始终按声明路径与写者名额排队。修改会重建运行时，任务运行期间无法变更。")}
    >
      <WriteLease port={port} onChanged={onChanged} />
    </Group>
  );
}
