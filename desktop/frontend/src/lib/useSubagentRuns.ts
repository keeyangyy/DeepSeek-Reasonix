// Loads a session's persisted sub-agent run sidecars.
//
// The transcript keeps no parent/child link and no live preview survives a
// restart, so the sub-agent panel and its topicbar badge get the nesting,
// settled status and dispatch model/effort from these sidecars. Loads are keyed
// by the tab AND its session identity: switching away and back re-reads the
// sidecars for the session that becomes visible (a long-running session keeps
// appending runs), while a late response for a tab that already moved on is
// discarded.

import { useEffect, useState } from "react";
import { app } from "./bridge";
import type { SubagentRunView } from "./subagentRunsBridge";

export function useSubagentRuns(tabId: string | undefined, sessionKey: string | undefined): readonly SubagentRunView[] {
  const [runs, setRuns] = useState<readonly SubagentRunView[]>([]);
  useEffect(() => {
    let active = true;
    if (!tabId) {
      setRuns([]);
      return () => { active = false; };
    }
    void app.ListSubagentsForTab(tabId)
      .then((loaded) => {
        if (active) setRuns(Array.isArray(loaded) ? loaded : []);
      })
      .catch(() => {
        // A missing sidecar directory is the normal empty case; the panel falls
        // back to whatever the transcript itself carries.
        if (active) setRuns([]);
      });
    return () => { active = false; };
    // sessionKey in the deps makes the re-read fire on a session switch even
    // when the tab id itself is unchanged.
  }, [tabId, sessionKey]);
  return runs;
}
