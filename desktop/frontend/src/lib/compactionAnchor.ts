// compactionAnchor.ts — 压缩卡片的切回恢复锚点。
// 压缩卡片是 live 事件产物（不持久化），hydrate 重建 items 后按锚点插回原位：
// usersAfter = 卡片之后（更晚）的 user 行数，anchorText = 其中第一条 user 的文本。
// transcript 的 user 行序列跨重建不变 → "倒数第 N 个 user 行之前"即原位；
// 锚点失效（rewind/编辑历史）回退 append 末尾（旧行为）。
// 泛型 + 最小结构约束：与 useController 无 import 依赖（避免循环）。
export interface AnchorRowLike {
  id: string;
  kind: string;
  text?: string;
}

export type CompactionCacheEntry<T extends AnchorRowLike> = {
  card: T;
  usersAfter: number;
  anchorText?: string;
};

// Module-level cache keyed by session path: switching tabs can rebuild the
// per-tab controller state entirely (compact.trace: on switch-back the reset
// input already has zero compaction rows), so the cache outlives any single
// state instance and is re-applied on every items rebuild.
const liveCompactionsCache = new Map<
  string,
  CompactionCacheEntry<AnchorRowLike>[]
>();

function compactionAnchor(
  items: readonly AnchorRowLike[],
  cardIndex: number,
): { usersAfter: number; anchorText?: string } {
  let users = 0;
  let anchorText: string | undefined;
  for (let i = items.length - 1; i > cardIndex; i -= 1) {
    const it = items[i];
    if (it.kind === "user") {
      users += 1;
      // Reverse iteration: the last assignment is the user row closest to the
      // card, i.e. the first user row after it.
      anchorText = it.text;
    }
  }
  return { usersAfter: users, anchorText };
}

// Record a finished compaction so its card survives a tab switch (controller
// state may be rebuilt entirely). The anchor is refreshed on every new user
// row (the only variable in the anchor), so a later rebuild restores the card
// at its current spot, not where it sat when compaction finished.
export function recordCompactionDone<T extends AnchorRowLike>(
  sessionPath: string,
  items: readonly T[],
  cardIndex: number,
  card: T,
): void {
  const existing = liveCompactionsCache.get(sessionPath) ?? [];
  const entry = {
    card,
    ...compactionAnchor(items, cardIndex),
  } as CompactionCacheEntry<AnchorRowLike>;
  const nextCache = existing.some((it) => it.card.id === entry.card.id)
    ? existing.map((it) => (it.card.id === entry.card.id ? entry : it))
    : [...existing, entry];
  liveCompactionsCache.set(sessionPath, nextCache);
}

// New user rows are the only variable in the anchor: refresh cached anchors
// so a tab-switch rebuild later restores the card at its current spot.
export function refreshCompactionAnchors<T extends AnchorRowLike>(
  sessionPath: string,
  items: readonly T[],
): void {
  const cached = liveCompactionsCache.get(sessionPath);
  if (!cached || cached.length === 0) return;
  liveCompactionsCache.set(
    sessionPath,
    cached.map((entry) => {
      const idx = items.findIndex((it) => it.id === entry.card.id);
      return idx >= 0
        ? ({
            ...entry,
            ...compactionAnchor(items, idx),
          } as CompactionCacheEntry<AnchorRowLike>)
        : entry;
    }),
  );
}

function cachedCompactions<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  prevItems: readonly T[],
): CompactionCacheEntry<T>[] {
  const cached = sessionPath
    ? liveCompactionsCache.get(sessionPath)
    : undefined;
  if (cached && cached.length > 0) return cached as CompactionCacheEntry<T>[];
  const entries: CompactionCacheEntry<T>[] = [];
  prevItems.forEach((it, index) => {
    if (it.kind === "compaction")
      entries.push({ card: it, ...compactionAnchor(prevItems, index) });
  });
  return entries;
}

// Insert cards before their anchor user row (Nth from the end), keeping cache
// order within one anchor; cards without a usable anchor append at the end.
// Exception: usersAfter === 0 (the card sat at the stream end when compaction
// finished and no user row followed) means every rebuilt history row is
// post-compaction content — the card belongs BEFORE that history (top), not
// after it. Rebuilds that load older pages above keep working via the anchor
// refresh on user append.
function insertCompactionsAtAnchors<T extends AnchorRowLike>(
  nextItems: T[],
  cards: readonly CompactionCacheEntry<T>[],
): T[] {
  const userCount = nextItems.reduce(
    (n, it) => (it.kind === "user" ? n + 1 : n),
    0,
  );
  const byAnchor = new Map<number, CompactionCacheEntry<T>[]>();
  const head: T[] = [];
  const tail: T[] = [];
  for (const entry of cards) {
    if (entry.usersAfter <= 0 || entry.usersAfter > userCount) {
      if (entry.usersAfter === 0) head.push(entry.card);
      else tail.push(entry.card);
      continue;
    }
    const bucket = byAnchor.get(entry.usersAfter);
    if (bucket) bucket.push(entry);
    else byAnchor.set(entry.usersAfter, [entry]);
  }
  const out: T[] = [];
  let seenUsers = 0;
  for (let i = nextItems.length - 1; i >= 0; i -= 1) {
    const it = nextItems[i];
    if (it.kind === "user") {
      seenUsers += 1;
      const bucket = byAnchor.get(seenUsers);
      if (bucket) {
        // The anchor must name the same user row it named while live: a
        // rewind can leave a history whose user count coincides with the
        // anchor but whose rows are older turns — those cards belong at the
        // end (with the tail), not before unrelated turns.
        const matched = bucket.every(
          (e) => e.anchorText !== undefined && e.anchorText === it.text,
        );
        if (matched) {
          // out is built in reverse; push user first, then the cards reversed,
          // so the final .reverse() yields [..., ...cards, user, ...] with the
          // cards in cache (chronological) order.
          out.push(it, ...[...bucket.map((e) => e.card)].reverse());
          continue;
        }
        for (const e of bucket) tail.push(e.card);
      }
    }
    out.push(it);
  }
  out.reverse();
  out.push(...tail);
  return head.length > 0 ? [...head, ...out] : out;
}

// preserveLiveCompactions carries the session's compaction cards (live event
// products, not part of persisted history) across any hydrate-driven items
// rebuild, so switching away and back keeps the compression summary visible
// at its original spot. nextItems already containing a compaction row (legacy
// event-log history) wins — never duplicate cards.
export function preserveLiveCompactions<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  prevItems: readonly T[],
  nextItems: T[],
): T[] {
  const compactions = cachedCompactions(sessionPath, prevItems);
  if (
    compactions.length === 0 ||
    nextItems.some((it) => it.kind === "compaction")
  )
    return nextItems;
  const merged = insertCompactionsAtAnchors(nextItems, compactions);
  if (sessionPath)
    liveCompactionsCache.set(
      sessionPath,
      compactions as CompactionCacheEntry<AnchorRowLike>[],
    );
  return merged;
}
