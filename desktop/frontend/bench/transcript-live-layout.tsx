import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/components/Transcript";
import { LocaleProvider } from "../src/lib/i18n";
import type { Item } from "../src/lib/useController";
import "../src/styles.css";

function TranscriptProbe() {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [id, setId] = useState("live-layout-probe");
  (window as Window & { reasonixLayoutProbe?: unknown }).reasonixLayoutProbe = {
    update(nextText: string, nextStreaming = true, nextId = "live-layout-probe") {
      setText(nextText);
      setStreaming(nextStreaming);
      setId(nextId);
    },
  };
  const items: Item[] = [
    { kind: "user", id: "live-layout-user", text: "live layout probe" },
    { kind: "assistant", id, text: streaming ? "" : text, reasoning: "", streaming },
  ];
  return (
    <div className="app app--creation" style={{ width: 900, height: 700, margin: "24px auto", border: "1px solid #aaa" }}>
      <Transcript
        items={items}
        live={streaming ? { id, text, reasoning: "", reasoningComplete: true } : undefined}
        onPrompt={() => undefined}
        tabId="live-layout-probe"
        geometrySessionKey="live-layout-probe"
        running={streaming}
        creationMode
        welcomeVariant="creation"
        questionNavigator={false}
      />
    </div>
  );
}

createRoot(document.getElementById("transcript-root")!).render(<LocaleProvider><TranscriptProbe /></LocaleProvider>);
