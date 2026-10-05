import type { Item, LiveStream, State } from "./useController";

type AssistantItem = Extract<Item, { kind: "assistant" }>;

export function assistantHasContent(item: AssistantItem | undefined, live?: LiveStream): boolean {
  return Boolean(
    `${live?.text ?? ""}${live?.reasoning ?? ""}${item?.text ?? ""}${item?.reasoning ?? ""}`.trim()
    || item?.memoryCitations?.length
    || item?.searchSources?.length
  );
}

export function removeEmptyAssistantItems(items: Item[]): Item[] {
  return items.filter((item) => item.kind !== "assistant" || assistantHasContent(item));
}

/** Allocate one provider sampling segment without changing the backend turn identity. */
export function ensureAssistant(s: State): State {
  if (s.currentAssistant && s.items.some((item) => item.kind === "assistant" && item.id === s.currentAssistant)) return s;
  const ordinal = s.assistantSegmentOrdinal;
  const id = s.activeTurnId ? `a:${s.activeTurnId}:${ordinal}` : `a${s.seq}`;
  const item: AssistantItem = { kind: "assistant", id, text: "", reasoning: "", streaming: true, wasStreamed: true, searchSources: s.pendingSearchSources?.length ? s.pendingSearchSources : undefined };
  return {
    ...s,
    items: [...s.items, item],
    currentAssistant: id,
    pendingSearchSources: undefined,
    seq: s.seq + 1,
    assistantSegmentOrdinal: ordinal + 1,
  };
}

// Re-stamp the active assistant row with the backend-minted message id. The row
// usually already exists (turn_started creates it), so ensureAssistant returns
// early without it and the live row could never be matched to the page row.
export function stampAssistantMessageID(s: State, messageID: string): State {
  if (!messageID || !s.currentAssistant) return s;
  let changed = false;
  const items = s.items.map((item) => {
    if (item.kind !== "assistant" || item.id !== s.currentAssistant || item.messageID === messageID) return item;
    changed = true;
    return { ...item, messageID };
  });
  return changed ? { ...s, items } : s;
}

export function ensureActiveAssistant(s: State): State {
  const active = ensureAssistant(s);
  const id = active.currentAssistant!;
  return active.live?.id === id ? active : { ...active, live: { id, text: "", reasoning: "", reasoningComplete: false } };
}
