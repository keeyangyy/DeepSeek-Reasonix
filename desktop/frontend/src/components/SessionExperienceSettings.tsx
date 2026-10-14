import { SettingsOptions } from "./SettingsOptions";
import { useEffect, useState } from "react";
import { FoldVertical, PanelBottom } from "lucide-react";
import { app } from "../lib/bridge";
import { useT } from "../lib/i18n";
import { useCommittedCommand } from "../lib/useCommittedCommand";
import { applySessionExperience, getSessionExperience, type SessionExperience } from "../lib/sessionExperience";
import { getDefaultCollapsed, setDefaultCollapsed } from "../lib/defaultCollapsedPreference";
import { getProcessFoldPolicy, setProcessFoldPolicy, type ProcessFoldPolicy } from "../lib/processFoldPolicy";
import { hydrateReasoningDisplayMode } from "../lib/reasoningDisplayPreference";
import type { SettingsView } from "../lib/types";
import { SettingsField, SettingsSection } from "./SettingsForm";

type Props = {
  snapshot: SettingsView;
  busy: boolean;
  apply: (write: () => Promise<unknown>) => Promise<boolean>;
};

const PROCESS_FOLD_POLICIES = ["follow-turn", "collapsed", "active-only"] as const;
const PROCESS_FOLD_POLICY_LABEL_KEYS: Record<ProcessFoldPolicy,
  "settings.processFoldPolicy.followTurn" | "settings.processFoldPolicy.collapsed" | "settings.processFoldPolicy.activeOnly"> = {
  "follow-turn": "settings.processFoldPolicy.followTurn",
  collapsed: "settings.processFoldPolicy.collapsed",
  "active-only": "settings.processFoldPolicy.activeOnly",
};

export function SessionExperienceSettings({ snapshot, busy, apply }: Props) {
  const t = useT();
  const [mode, setMode] = useState<SessionExperience>(getSessionExperience);
  const [startCollapsed, setStartCollapsed] = useState(getDefaultCollapsed);
  const [foldPolicy, setFoldPolicy] = useState<ProcessFoldPolicy>(getProcessFoldPolicy);
  const present = useCommittedCommand((next: SessionExperience) => {
    setMode(next);
    applySessionExperience(next);
    hydrateReasoningDisplayMode(next === "deep" ? "expanded" : "auto", next === "deep");
  });
  // Snapshot identity matters: a failed write may reload the same backend value.
  useEffect(() => { present(snapshot.sessionExperience === "deep" ? "deep" : "standard"); }, [snapshot, present]);
  const save = useCommittedCommand(async (next: SessionExperience) => {
    present(next);
    // The shared Settings apply/reload path owns both success and failure.
    await apply(() => app.SetSessionExperience(next));
  });
  return <SettingsSection title={t("settings.general.sectionConversation")} description={t("settings.sessionExperienceHint")}>
    <SettingsField label={t("settings.sessionExperience")} hint={mode === "deep" ? t("settings.sessionExperience.deepHint") : t("settings.sessionExperience.standardHint")} icon={<PanelBottom size={18} />}>
      <SettingsOptions layout="field" className="set-seg" role="radiogroup" aria-label={t("settings.sessionExperience")}>
        {(["standard", "deep"] as const).map(value => <button key={value} type="button"
          className={`set-seg__btn${mode === value ? " set-seg__btn--on" : ""}`} role="radio"
          aria-checked={mode === value} disabled={busy} onClick={() => void save(value)}>
          {t(`settings.sessionExperience.${value}`)}
        </button>)}
      </SettingsOptions>
    </SettingsField>
    <SettingsField label={t("settings.defaultCollapsed")} hint={t("settings.defaultCollapsedHint")} icon={<PanelBottom size={18} />}>
      <SettingsOptions layout="field" className="set-seg" role="radiogroup" aria-label={t("settings.defaultCollapsed")}>
        {([false, true] as const).map(value => <button key={String(value)} type="button"
          className={`set-seg__btn${startCollapsed === value ? " set-seg__btn--on" : ""}`} role="radio"
          aria-checked={startCollapsed === value} disabled={busy}
          onClick={() => { setStartCollapsed(value); setDefaultCollapsed(value); }}>
          {t(value ? "settings.defaultCollapsed.on" : "settings.defaultCollapsed.off")}
        </button>)}
      </SettingsOptions>
    </SettingsField>
    <SettingsField
      label={t("settings.processFoldPolicy")}
      hint={mode === "deep" ? t("settings.processFoldPolicy.deepHint") : t("settings.processFoldPolicyHint")}
      icon={<FoldVertical size={18} />}
    >
      <SettingsOptions layout="field" className="set-seg" role="radiogroup" aria-label={t("settings.processFoldPolicy")}>
        {PROCESS_FOLD_POLICIES.map(value => <button key={value} type="button"
          className={`set-seg__btn${foldPolicy === value ? " set-seg__btn--on" : ""}`} role="radio"
          aria-checked={foldPolicy === value} disabled={busy || mode === "deep"}
          onClick={() => { setFoldPolicy(value); setProcessFoldPolicy(value); }}>
          {t(PROCESS_FOLD_POLICY_LABEL_KEYS[value])}
        </button>)}
      </SettingsOptions>
    </SettingsField>
  </SettingsSection>;
}
