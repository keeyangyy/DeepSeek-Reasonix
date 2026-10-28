import { CornerDownRight, List } from "lucide-react";
import type React from "react";
import { useI18n } from "../lib/i18n";
import type { GuidanceTarget } from "../lib/composerGuidanceTarget";

// Kept out of the locale bundle: the zh chunk sits at its gzip ceiling. Three
// short labels, not a system.
const COPY = {
  en: ["This turn", "Queue", "Where a mid-turn interjection goes"],
  zh: ["本轮", "队列", "插话去处"],
  "zh-TW": ["本輪", "佇列", "插話去處"],
} as const;

/**
 * Picks where a mid-turn interjection lands: injected into the running turn
 * (steer) or queued for the next one (followup).
 *
 * Plain text follows this choice. A draft carrying a command or skill entity
 * does not: those can only start their own turn, because a running turn has
 * already fixed its input and the steer channel carries text alone. That limit
 * lives in the submit path, not here — the control stays live so the next plain
 * message still honours the choice.
 */
export function ComposerGuidanceTargetToggle({
  target,
  onChange,
  disabled,
}: {
  target: GuidanceTarget;
  onChange: (next: GuidanceTarget) => void;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const [nowLabel, queueLabel, title] = COPY[locale] ?? COPY.en;

  const segments = [
    { value: "steer" as const, label: nowLabel, icon: <CornerDownRight size={14} /> },
    { value: "followup" as const, label: queueLabel, icon: <List size={14} /> },
  ];

  return (
    <div className="composer-meta__control composer-meta__control--target" title={title}>
      <div
        className="composer-modebar composer-modebar--target"
        data-target={target}
        style={{ "--composer-modebar-index": target === "followup" ? 1 : 0 } as React.CSSProperties}
      >
        <span className="composer-modebar__thumb" aria-hidden="true" />
        {segments.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            className={`composer-modebar__item${target === value ? " composer-modebar__item--active" : ""}`}
            onClick={() => onChange(value)}
            disabled={disabled}
            aria-pressed={target === value}
            title={label}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
