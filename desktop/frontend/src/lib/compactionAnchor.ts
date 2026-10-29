// compactionAnchor.ts — 压缩卡片在 items 重建时的锚点恢复。
//
// 压缩卡片是 live 事件产物（不持久化），hydrate / 切会话重建 items 后要插回
// 原来的位置。锚点只有一个：anchorUsers —— 压缩分界处之前的真实 user 消息
// 条数，压缩时由后端写进 sidecar（CompactionRecord.AnchorUserMessages）。
//
// 插入规则：卡片放在「第 anchorUsers+1 个 user 行之前」，即第 anchorUsers 轮
// 结束后的轮次边界。三种情形自然统一：
//   - 压缩发生在最新一轮之后 → anchorUsers 等于当前 user 总数 → 卡片落在末尾；
//   - 压缩后又有新对话 → 卡片停在原轮次边界，不被新消息推走；
//   - 分页窗口不含那么早的行 → 落到末尾，而不是塞进无关回合。
//
// 早先的实现用 usersAfter（卡片之后还有几条 user）判位置：卡片在末尾时它恒
// 为 0，于是重启 / 切回一律把它插到会话最顶部——这就是「位置丢失、乱插入」
// 的来源，不再使用。
//
// 泛型 + 最小结构约束：与 useController 无 import 依赖（避免循环）。
export interface AnchorRowLike {
  id: string;
  kind: string;
  text?: string;
  /** 压缩卡片专用：true 表示这张卡还在压缩中（尚未完成）。 */
  pending?: boolean;
  /** 压缩卡片专用：压缩分界前有多少条 user 消息；undefined = 无位置（落末尾）。 */
  anchorUsers?: number;
  /** 压缩卡片专用：卡片所属会话，重建 items 时用于判断能否从旧 items 兜底。 */
  sessionPath?: string;
}

export type CompactionCacheEntry<T extends AnchorRowLike> = {
  card: T;
  anchorUsers: number;
};

// Module-level cache keyed by session path: switching tabs can rebuild the
// per-tab controller state entirely (compact.trace: on switch-back the reset
// input already has zero compaction rows), so the cache outlives any single
// state instance and is re-applied on every items rebuild.
const liveCompactionsCache = new Map<string, CompactionCacheEntry<AnchorRowLike>[]>();

export function compactionUserCount(items: readonly AnchorRowLike[]): number {
  return items.reduce((count, item) => (item.kind === "user" ? count + 1 : count), 0);
}

function userCountBefore(items: readonly AnchorRowLike[], index: number): number {
  let users = 0;
  for (let cursor = 0; cursor < index && cursor < items.length; cursor += 1) {
    if (items[cursor].kind === "user") users += 1;
  }
  return users;
}

function anchorOf(card: AnchorRowLike): number {
  return typeof card.anchorUsers === "number" && card.anchorUsers >= 0
    ? card.anchorUsers
    : Number.POSITIVE_INFINITY;
}

// 第 anchorUsers+1 个 user 行之前；锚点缺失或当前窗口里的 user 不够 → 末尾。
function insertIndexFor(items: readonly AnchorRowLike[], card: AnchorRowLike): number {
  const anchor = anchorOf(card);
  if (!Number.isFinite(anchor)) return items.length;
  let users = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind !== "user") continue;
    if (users === anchor) return index;
    users += 1;
  }
  return items.length;
}

/** 把多张卡片按各自锚点插回 items；锚点升序、同锚点保持传入顺序。 */
export function insertCompactionCards<T extends AnchorRowLike>(
  items: readonly T[],
  cards: readonly T[],
): T[] {
  if (cards.length === 0) return [...items];
  const ordered = [...cards].sort((left, right) => anchorOf(left) - anchorOf(right));
  const out = [...items];
  for (const card of ordered) out.splice(insertIndexFor(out, card), 0, card);
  return out;
}

/** 单卡落位：先摘掉同 id 的旧卡，再按锚点放回。 */
export function placeCompactionCard<T extends AnchorRowLike>(items: readonly T[], card: T): T[] {
  const others = items.filter((item) => item.id !== card.id);
  return insertCompactionCards(others, [card]);
}

function entryForCard<T extends AnchorRowLike>(
  items: readonly T[],
  index: number,
  card: T,
): CompactionCacheEntry<T> {
  // 卡片自带锚点就以它为准：实时压缩开始时写下的位置，后续新 user 行不改它。
  const anchorUsers = typeof card.anchorUsers === "number" && card.anchorUsers >= 0
    ? card.anchorUsers
    : userCountBefore(items, index);
  return { card: { ...card, anchorUsers }, anchorUsers };
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
// state may be rebuilt entirely). anchorUsers is the stable anchor: it names
// the turn boundary the compaction closed, not the card's current offset.
export function recordCompactionDone<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  items: readonly T[],
  cardIndex: number,
  card: T,
): void {
  const entry = entryForCard(items, cardIndex, card);
  const cacheKey = sessionPath ?? "";
  const existing = liveCompactionsCache.get(cacheKey) ?? [];
  const nextCache = existing.some((item) => item.card.id === entry.card.id)
    ? existing.map((item) => (item.card.id === entry.card.id ? (entry as CompactionCacheEntry<AnchorRowLike>) : item))
    : [...existing, entry as CompactionCacheEntry<AnchorRowLike>];
  liveCompactionsCache.set(cacheKey, nextCache);
}

// New user rows never move the anchor — it is the boundary the compaction
// closed. Only cards that still lack one (legacy rows) learn it from where they
// currently sit, so a later rebuild can place them without the old tail-biased
// guess.
export function refreshCompactionAnchors<T extends AnchorRowLike>(
  sessionPath: string,
  items: readonly T[],
): void {
  const cached = liveCompactionsCache.get(sessionPath);
  if (!cached || cached.length === 0) return;
  let changed = false;
  const next = cached.map((entry) => {
    if (typeof entry.card.anchorUsers === "number") return entry;
    const index = items.findIndex((item) => item.id === entry.card.id);
    if (index < 0) return entry;
    changed = true;
    return entryForCard(items, index, entry.card as T) as CompactionCacheEntry<AnchorRowLike>;
  });
  if (changed) liveCompactionsCache.set(sessionPath, next);
}

function cachedCards<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  prevItems: readonly T[],
): T[] {
  const cached = liveCompactionsCache.get(sessionPath ?? "");
  if (cached && cached.length > 0) return cached.map((entry) => entry.card as T);
  // 卡片自带会话归属时只取同会话的：重启 / 切回来重建 items 时，prevItems 里的
  // 卡片就是这一张，必须能兜底找回；不同会话的卡片才丢弃，避免串会话。没有
  // 归属标记的旧卡片只在会话未知时使用（保持原行为）。
  return prevItems.reduce<T[]>((cards, item, index) => {
    if (item.kind !== "compaction") return cards;
    if (sessionPath && item.sessionPath !== sessionPath) return cards;
    const withAnchor = typeof item.anchorUsers === "number"
      ? item
      : { ...item, anchorUsers: userCountBefore(prevItems, index) };
    cards.push(withAnchor);
    return cards;
  }, []);
}

// preserveLiveCompactions carries the session's compaction cards across any
// hydrate-driven items rebuild, so switching away and back keeps the summary at
// the same turn boundary. nextItems already containing a compaction row
// (legacy event-log history) wins — never duplicate cards.
export function preserveLiveCompactions<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  prevItems: readonly T[],
  nextItems: T[],
): T[] {
  if (nextItems.some((item) => item.kind === "compaction")) return nextItems;
  const cards = cachedCards(sessionPath, prevItems);
  if (cards.length === 0) return nextItems;
  return insertCompactionCards(nextItems, cards);
}