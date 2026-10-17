import { SettingsOptions } from "./SettingsOptions";
import { useEffect, useState } from "react";
import { FoldVertical, PanelBottom } from "lucide-react";
import { app } from "../lib/bridge";
import { useT } from "../lib/i18n";
import { useCommittedCommand } from "../lib/useCommittedCommand";
import { applySessionExperience, getSessionExperience, type SessionExperience } from "../lib/sessionExperience";
import { getProcessFoldPolicy, setProcessFoldPolicy, type ProcessFoldPolicy } from "../lib/processFoldPolicy";
import {
  getReasoningExpansionPolicy,
  setReasoningExpansionPolicy,
  REASONING_EXPANSION_POLICIES,
  type ReasoningExpansionPolicy,
} from "../lib/reasoningExpansionPolicy";
import { hydrateReasoningDisplayMode } from "../lib/reasoningDisplayPreference";
import type { SettingsView } from "../lib/types";
import { SettingsField, SettingsSection } from "./SettingsForm";

type Props = {
  snapshot: SettingsView;
  busy: boolean;
  apply: (write: () => Promise<unknown>) => Promise<boolean>;
};

// Both inner-item controls run least → most expanded, so the three rows read in
// the same direction: session experience, then default folding, then process
// folding.
const PROCESS_FOLD_POLICIES = ["collapsed", "active-only", "follow-turn", "always-expanded"] as const;
const PROCESS_FOLD_POLICY_LABEL_KEYS: Record<ProcessFoldPolicy,
  "settings.processFoldPolicy.collapsed" | "settings.processFoldPolicy.activeOnly" | "settings.processFoldPolicy.followTurn" | "settings.processFoldPolicy.alwaysExpanded"> = {
  collapsed: "settings.processFoldPolicy.collapsed",
  "active-only": "settings.processFoldPolicy.activeOnly",
  "follow-turn": "settings.processFoldPolicy.followTurn",
  "always-expanded": "settings.processFoldPolicy.alwaysExpanded",
};
const EXPANSION_POLICY_LABEL_KEYS: Record<ReasoningExpansionPolicy,
  "settings.defaultCollapsed.collapsed" | "settings.defaultCollapsed.latestOnly" | "settings.defaultCollapsed.expanded"> = {
  "all-collapsed": "settings.defaultCollapsed.collapsed",
  "latest-only": "settings.defaultCollapsed.latestOnly",
  "all-expanded": "settings.defaultCollapsed.expanded",
};

export function SessionExperienceSettings({ snapshot, busy, apply }: Props) {
  const t = useT();
  const [mode, setMode] = useState<SessionExperience>(getSessionExperience);
  const [expansionPolicy, setExpansionPolicy] = useState<ReasoningExpansionPolicy>(getReasoningExpansionPolicy);
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
    <SettingsField
      label={t("settings.defaultCollapsed")}
      hint={mode === "deep" ? t("settings.defaultCollapsed.deepHint") : t("settings.defaultCollapsedHint")}
      icon={<PanelBottom size={18} />}
    >
      <SettingsOptions layout="field" className="set-seg" role="radiogroup" aria-label={t("settings.defaultCollapsed")}>
        {REASONING_EXPANSION_POLICIES.map(value => <button key={value} type="button"
          className={`set-seg__btn${expansionPolicy === value ? " set-seg__btn--on" : ""}`} role="radio"
          aria-checked={expansionPolicy === value} disabled={busy || mode === "deep"}
          onClick={() => { setExpansionPolicy(value); setReasoningExpansionPolicy(value); }}>
          {t(EXPANSION_POLICY_LABEL_KEYS[value])}
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
