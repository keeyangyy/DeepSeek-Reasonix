import { useEffect, useState, useSyncExternalStore } from "react";
import { onNavRailChange, showsNavRail } from "../state/prefs";
import { folded, onFolds } from "./viewport";

/** Whether the icon column is drawn: the machine's choice, unless the window has
 *  folded to the scene, where the workspace rail is a drawer and a permanent
 *  column would take the conversation's width. The fold is not written back to
 *  the choice, so widening the window restores what the reader picked. */
export function useNavRail(): boolean {
  const chosen = useSyncExternalStore(onNavRailChange, showsNavRail, showsNavRail);
  const [phone, setPhone] = useState(() => folded("scene"));
  useEffect(() => {
    setPhone(folded("scene"));
    return onFolds((now) => setPhone(now.split(" ").includes("scene")));
  }, []);
  return chosen && !phone;
}
