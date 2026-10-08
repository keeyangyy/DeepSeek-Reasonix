import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { onNavRailChange, setShowsNavRail, showsNavRail } from "../state/prefs";
import { Group } from "./Group";
import { Switch } from "./Switch";

export function NavRailSection() {
  const on = useSyncExternalStore(onNavRailChange, showsNavRail, showsNavRail);
  return (
    <Group id="navrail" title={t("图标栏")} hint={t("工作区栏旁的一列图标，直达用量、工具、扩展、记忆、远程、账号和设置。窗口窄到手机宽度时不显示。")}>
      <div className="lrow">
        <span className="tx">
          <span className="lb">{t("显示图标栏")}</span>
          <span className="ds">{t("关闭后这些页面仍可从设置打开")}</span>
        </span>
        <Switch data-action="appearance.nav-rail" on={on} label={t("显示图标栏")} onClick={() => setShowsNavRail(!on)} />
      </div>
    </Group>
  );
}
