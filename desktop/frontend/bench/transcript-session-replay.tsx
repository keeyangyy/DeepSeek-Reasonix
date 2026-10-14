import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/components/Transcript";
import { TurnEventProjector } from "../src/lib/turnEventProjection";
import { LocaleProvider } from "../src/lib/i18n";
import { historyMessagesToItems, initialState, reducer, type Item, type State } from "../src/lib/useController";
import type { HistoryMessage, TurnEventReplayView, WireEvent } from "../src/lib/types";
import "../src/styles.css";

type ReplaySnapshot = {
  itemCount: number;
  uniqueItemIds: number;
  kinds: Record<string, number>;
  tools: Array<{ id: string; name: string; status: string }>;
  assistantLengths: number[];
  liveTextLength: number;
  liveText: string;
  askPending: boolean;
  replayCalls: number;
  continuationAfterAsk: boolean;
};

type ReplayApi = {
  loadHistory(tabId: string, messages: HistoryMessage[], epoch?: string, sessionGeneration?: number): void;
  replaceHistory(tabId: string, messages: HistoryMessage[], epoch: string, sessionGeneration: number): void;
  switchTab(tabId: string): void;
  observe(tabId: string, epoch: string, turnId: string, sessionGeneration?: number): void;
  sendLive(tabId: string, event: WireEvent): boolean;
  deferReplay(tabId: string): void;
  releaseReplay(tabId: string, page: TurnEventReplayView): void;
  replayCalls(tabId: string): number;
  snapshot(tabId?: string): ReplaySnapshot | undefined;
};

function emptyState(): State {
  return reducer(initialState, { type: "history", messages: [] });
}

function replaySnapshot(state: State, replayCalls: number): ReplaySnapshot {
  const kinds: Record<string, number> = {};
  const tools: ReplaySnapshot["tools"] = [];
  const assistants: Extract<Item, { kind: "assistant" }>[] = [];
  for (const item of state.items) {
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    if (item.kind === "tool") tools.push({ id: item.id, name: item.name, status: item.status });
    if (item.kind === "assistant") assistants.push(item);
  }
  const askIndex = state.items.findIndex((item) => item.kind === "tool" && item.id === "replay-live-ask");
  const continuationIndex = state.items.findIndex((item, index) =>
    index > askIndex && item.kind === "assistant" && item.text.includes("测试结束，完整总结。"));
  return {
    itemCount: state.items.length,
    uniqueItemIds: new Set(state.items.map((item) => item.id)).size,
    kinds,
    tools,
    assistantLengths: assistants.map((item) => item.text.length),
    liveTextLength: state.live?.text.length ?? 0,
    liveText: state.live?.text ?? "",
    askPending: Boolean(state.ask),
    replayCalls,
    continuationAfterAsk: askIndex >= 0 && continuationIndex > askIndex,
  };
}

function TranscriptReplayProbe() {
  const [view, setView] = useState<{ tabId: string; state: State } | null>(null);
  const tabs = useRef(new Map<string, State>());
  const activeTab = useRef("");
  const replayPages = useRef(new Map<string, TurnEventReplayView>());
  const replayGates = useRef(new Map<string, { promise: Promise<TurnEventReplayView>; release: (page: TurnEventReplayView) => void }>());
  const replayCallCounts = useRef(new Map<string, number>());
  const projector = useRef<TurnEventProjector | null>(null);

  const stateFor = (tabId: string) => {
    let state = tabs.current.get(tabId);
    if (!state) {
      state = emptyState();
      tabs.current.set(tabId, state);
    }
    return state;
  };
  const applyProjectedEvent = (tabId: string, event: WireEvent) => {
    const next = reducer(stateFor(tabId), { type: "event", e: { ...event, tabId } });
    tabs.current.set(tabId, next);
    if (activeTab.current === tabId) setView({ tabId, state: next });
  };

  if (!projector.current) {
    projector.current = new TurnEventProjector();
    projector.current.bind((event) => applyProjectedEvent(event.tabId ?? activeTab.current, event));
  }

  const replayProvider = async (tabId: string, _afterSeq: number): Promise<TurnEventReplayView> => {
    replayCallCounts.current.set(tabId, (replayCallCounts.current.get(tabId) ?? 0) + 1);
    const gate = replayGates.current.get(tabId);
    if (gate) return gate.promise;
    return replayPages.current.get(tabId) ?? {
      events: [], floorSeq: 0, latestSeq: 0, nextAfterSeq: 0, hasMore: false, resetRequired: false,
    };
  };
  (window as Window & { __reasonixTurnEvents?: typeof replayProvider }).__reasonixTurnEvents = replayProvider;

  const api: ReplayApi = {
    loadHistory(tabId, messages, epoch = `epoch-${tabId}`, sessionGeneration = 0) {
      projector.current?.release(tabId);
      const next = reducer(emptyState(), { type: "history", messages });
      tabs.current.set(tabId, next);
      activeTab.current = tabId;
      projector.current?.observeRuntime(tabId, epoch, 0, undefined, true, `turn-${tabId}`, sessionGeneration);
      setView({ tabId, state: next });
    },
    replaceHistory(tabId, messages, epoch, sessionGeneration) {
      const next = reducer(emptyState(), { type: "history", messages });
      tabs.current.set(tabId, next);
      activeTab.current = tabId;
      projector.current?.observeRuntime(tabId, epoch, 0, undefined, true, `turn-${tabId}`, sessionGeneration);
      setView({ tabId, state: next });
    },
    switchTab(tabId) {
      activeTab.current = tabId;
      setView({ tabId, state: stateFor(tabId) });
    },
    observe(tabId, epoch, turnId, sessionGeneration = 0) {
      projector.current?.observeRuntime(tabId, epoch, 0, undefined, true, turnId, sessionGeneration);
    },
    sendLive(tabId, event) {
      const runtimeEpoch = event.runtimeEpoch ?? `epoch-${tabId}`;
      const tagged = { ...event, tabId, runtimeEpoch } as WireEvent;
      const accepted = projector.current?.acceptLive(tabId, tagged, runtimeEpoch) ?? false;
      if (accepted) applyProjectedEvent(tabId, tagged);
      return accepted;
    },
    deferReplay(tabId) {
      let release!: (page: TurnEventReplayView) => void;
      const promise = new Promise<TurnEventReplayView>((resolve) => { release = resolve; });
      replayGates.current.set(tabId, { promise, release });
    },
    releaseReplay(tabId, page) {
      replayPages.current.set(tabId, page);
      const gate = replayGates.current.get(tabId);
      replayGates.current.delete(tabId);
      gate?.release(page);
    },
    replayCalls(tabId) { return replayCallCounts.current.get(tabId) ?? 0; },
    snapshot(tabId = activeTab.current) {
      const state = tabs.current.get(tabId);
      return state ? replaySnapshot(state, replayCallCounts.current.get(tabId) ?? 0) : undefined;
    },
  };
  (window as Window & { reasonixReplayProbe?: ReplayApi }).reasonixReplayProbe = api;

  const tabId = view?.tabId ?? "replay-empty";
  const state = view?.state;
  const items = state?.items ?? [];
  return (
    <div className="app app--creation" style={{ width: 1100, height: 760, margin: "20px auto", border: "1px solid #aaa" }}>
      <Transcript
        items={items}
        live={state?.live}
        onPrompt={() => undefined}
        tabId={tabId}
        geometrySessionKey={tabId}
        running={state?.running ?? false}
        creationMode
        welcomeVariant="creation"
        questionNavigator={false}
        historyMutation={state?.historyMutation}
      />
    </div>
  );
}

// Keep the converter import exercised in this page as well as the reducer: this
// is the same history-to-transcript entry path used by restored sessions.
void historyMessagesToItems;

createRoot(document.getElementById("transcript-root")!).render(<LocaleProvider><TranscriptReplayProbe /></LocaleProvider>);
