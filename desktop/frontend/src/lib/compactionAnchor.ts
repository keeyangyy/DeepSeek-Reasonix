// compactionAnchor.ts — 压缩卡片的切回恢复锚点。
//
// 压缩卡片是 live 事件产物（不持久化），hydrate 重建 items 后要插回原位。
// 定位用 usersBefore（卡片之前有多少条 user 行），不用“卡片之后还有几条”：
// 后者在卡片处于末尾时等于 0，无法和“重启后历史全是压缩后内容”区分，
// 两条路径会得到相反的落点（末尾 vs 顶部）。
// usersBefore 则天然区分：卡片在末尾 = 全部 user 数；历史被重新加载导致
// 卡片之前的内容不在了 = 大于当前 user 总数 → 才放顶部。
//
// 泛型 + 最小结构约束：与 useController 无 import 依赖（避免循环）。
export interface AnchorRowLike {
  id: string;
  kind: string;
  text?: string;
  /** 压缩卡片专用：true 表示这张卡还在压缩中（尚未完成）。 */
  pending?: boolean;
}

export type CompactionCacheEntry<T extends AnchorRowLike> = {
  card: T;
  /**
   * 进行中的卡片：位置锚点是 usersBefore（卡片之前有多少 user 行），
   * 切回时回到它原来所在的末尾位置。
   */
  pending?: boolean;
  /** 位置主锚点（仅 pending 卡片使用）。 */
  usersBefore?: number;
  /**
   * 完成的卡片沿用 usersAfter（卡片之后还有多少 user 行）：它代表被折叠的
   * 区段，0 表示整段历史都在它之后，卡片应排在历史之前（顶部）。
   */
  usersAfter?: number;
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
): { usersBefore: number; usersAfter: number; anchorText?: string } {
  // usersBefore 是位置主锚点：卡片之前有多少条 user 行。卡片在末尾时它等于
  // 全部 user 行数，重建后插回末尾；只有它超过重建后的 user 总数（说明卡片
  // 之前的内容已不在页窗口里）才把卡片放顶部。
  let usersBefore = 0;
  for (let i = 0; i < cardIndex; i += 1) {
    if (items[i].kind === "user") usersBefore += 1;
  }
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
  return { usersBefore, usersAfter: users, anchorText };
}

/** 压缩一开始就把 pending 卡片连同锚点记进缓存：切走会重建 state，没有缓存条目它就没处可回。 */
export function recordCompactionStarted<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  items: readonly T[],
): void {
  if (!sessionPath || items.length === 0) return;
  recordCompactionDone(sessionPath, items, items.length - 1, items[items.length - 1]);
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
    // 记录卡片状态：进行中的卡片要回到它原来的位置（通常在末尾），已完成
    // 的卡片沿用 usersAfter 语义（折叠区段之后的历史判定）。两者混用会让
    // 「压缩中切走」和「压缩完成后切回」得到相反的落点。
    pending: card.pending === true,
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
  // 明确知道会话归属时不用 prevItems 兜底：切换会话时 prevItems 里还留着
  // 上一个会话的卡片，提取会把它们泄漏进新会话。缓存为空就是「这个会话
  // 没有压缩记录」，而不是「去别人的列表里找」。
  if (sessionPath) return [];
  const entries: CompactionCacheEntry<T>[] = [];
  prevItems.forEach((it, index) => {
    if (it.kind === "compaction")
      entries.push({ card: it, ...compactionAnchor(prevItems, index) });
  });
  return entries;
}

// Insert cached compaction cards back into a rebuilt items list.
//
// 两类卡片要相反的落点，必须分开算：
//
//   - pending（压缩还在跑时切走）：用 usersBefore。它在压缩开始时被插到当时
//     的位置（通常是消息流末尾），切回后要回到那里。不能用 usersAfter ——
//     卡片在末尾时 usersAfter=0，会被误判成“历史全是压缩后内容”。
//   - 已完成：沿用 usersAfter。它代表被折叠的区段，0（或超出当前页窗口）表示
//     整段重建历史都在它之后，卡片应排最前（顶部）——462 条 manual 压缩实测
//     得出的语义。
function insertCompactionsAtAnchors<T extends AnchorRowLike>(
  nextItems: T[],
  cards: readonly CompactionCacheEntry<T>[],
): T[] {
  const userCount = nextItems.reduce(
    (n, it) => (it.kind === "user" ? n + 1 : n),
    0,
  );

  const pendingByBefore = new Map<number, CompactionCacheEntry<T>[]>();
  const doneByAfter = new Map<number, CompactionCacheEntry<T>[]>();
  const head: T[] = [];
  const tail: T[] = [];

  for (const entry of cards) {
    if (entry.pending === true) {
      const before = typeof entry.usersBefore === "number" ? entry.usersBefore : -1;
      if (before < 0 || before > userCount) {
        head.push(entry.card);
        continue;
      }
      const bucket = pendingByBefore.get(before);
      if (bucket) bucket.push(entry);
      else pendingByBefore.set(before, [entry]);
      continue;
    }
    const after = typeof entry.usersAfter === "number" ? entry.usersAfter : 0;
    if (after <= 0 || after > userCount) {
      head.push(entry.card);
      continue;
    }
    const bucket = doneByAfter.get(after);
    if (bucket) bucket.push(entry);
    else doneByAfter.set(after, [entry]);
  }

  // 已完成卡片：从后往前扫，插在对应 user 行之前；anchorText 对不上
  // （rewind/编辑改写了历史）就退到末尾，不塞进无关回合里。
  const out: T[] = [];
  let seenUsers = 0;
  for (let i = nextItems.length - 1; i >= 0; i -= 1) {
    const it = nextItems[i];
    if (it.kind === "user") {
      seenUsers += 1;
      const bucket = doneByAfter.get(seenUsers);
      if (bucket) {
        const matched = bucket.every(
          (e) => e.anchorText !== undefined && e.anchorText === it.text,
        );
        if (matched) {
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

  // 进行中卡片：usersBefore=0 排最前，= userCount 追加末尾（原位置）。
  const merged: T[] = [];
  const leading = pendingByBefore.get(0);
  if (leading) merged.push(...leading.map((e) => e.card));
  let walked = 0;
  for (const it of out) {
    merged.push(it);
    if (it.kind === "user") {
      walked += 1;
      if (walked >= userCount) continue;
      const bucket = pendingByBefore.get(walked);
      if (bucket) merged.push(...bucket.map((e) => e.card));
    }
  }
  const trailing = pendingByBefore.get(userCount);
  if (trailing) merged.push(...trailing.map((e) => e.card));

  return head.length > 0 ? [...head, ...merged] : merged;
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
