// compactionAnchor.ts — 压缩卡片在 items 重建时的位置恢复。
//
// 压缩卡片是 live 事件产物（不持久化），hydrate / 切会话 / 翻页重建 items 后
// 要插回原来的位置。位置只用一个锚：anchorMessageId —— 压缩开始时对话停在哪
// 条消息，由后端写进 sidecar（CompactionRecord.AnchorMessageID）。
//
// 规则：
//   - 按 id 找到那条消息 → 卡片插在它之后；
//   - 找不到（那条消息还没被分页加载）→ **卡片不显示**。压缩点本身没显示出来，
//     卡片当然也不该出现；等用户上滑把它加载进来，卡片自然出现，位置固定。
//
// 早先的实现用「第几轮」当锚点，那是错的：轮数要靠数，而后端数的是会话里的
// user 记录、前端渲染的是 user 气泡，两者对注入消息（<session-context>、
// <background-jobs>、轮中插话、工具不可用提示）的处理各不相同，口径一错就整体
// 偏移；更要命的是分页窗口只加载最近几轮，绝对轮数随之失效，卡片会随加载量
// 变化位置。消息 id 没有这些问题。
//
// 泛型 + 最小结构约束：与 useController 无 import 依赖（避免循环）。
export interface AnchorRowLike {
  id: string;
  kind: string;
  text?: string;
  /** 消息自身的 ULID：压缩卡片据此定位（卡片自己也有 messageID，但不参与定位）。 */
  messageID?: string;
  /** 压缩卡片专用：true 表示这张卡还在压缩中（尚未完成）。 */
  pending?: boolean;
  /** 压缩卡片专用：压缩开始时对话停在的那条消息的 ULID；缺失 = 无从定位，不显示。 */
  anchorMessageId?: string;
  /** 压缩卡片专用：卡片所属会话，重建 items 时用于判断能否从旧 items 兜底。 */
  sessionPath?: string;
}

export type CompactionCacheEntry<T extends AnchorRowLike> = { card: T };

// Module-level cache keyed by session path: switching tabs can rebuild the
// per-tab controller state entirely (compact.trace: on switch-back the reset
// input already has zero compaction rows), so the cache outlives any single
// state instance and is re-applied on every items rebuild.
const liveCompactionsCache = new Map<string, CompactionCacheEntry<AnchorRowLike>[]>();

/** 压缩开始时该把卡片锚在哪：当前 items 里最后一条带 ULID 的消息。 */
export function compactionAnchorMessageID(items: readonly AnchorRowLike[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].messageID) return items[index].messageID;
  }
  return undefined;
}

// 卡片该插入的下标（插在锚点消息之后）；找不到锚点消息返回 -1（= 不显示）。
// 压缩中的卡片没有锚点时直接放末尾：它是刚发生的，位置就是当前结尾。
function insertIndexFor(items: readonly AnchorRowLike[], card: AnchorRowLike): number {
  const anchorID = card.anchorMessageId;
  if (!anchorID) return card.pending ? items.length : -1;
  const index = items.findIndex((item) => item.messageID === anchorID);
  return index >= 0 ? index + 1 : -1;
}

/**
 * 把卡片按各自锚点插回 items。锚点消息不在当前窗口的卡片直接跳过——它们的
 * 位置在更早的未加载区间，硬插一个位置只会误导。
 */
export function insertCompactionCards<T extends AnchorRowLike>(
  items: readonly T[],
  cards: readonly T[],
): T[] {
  if (cards.length === 0) return [...items];
  const placed = cards
    .map((card) => ({ card, index: insertIndexFor(items, card) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (placed.length === 0) return [...items];
  const out = [...items];
  let offset = 0;
  for (const entry of placed) {
    out.splice(entry.index + offset, 0, entry.card);
    offset += 1;
  }
  return out;
}

/** 单卡落位：先摘掉同 id 的旧卡，再按锚点放回。 */
export function placeCompactionCard<T extends AnchorRowLike>(items: readonly T[], card: T): T[] {
  return insertCompactionCards(items.filter((item) => item.id !== card.id), [card]);
}

function entryForCard<T extends AnchorRowLike>(items: readonly T[], index: number, card: T): CompactionCacheEntry<T> {
  // 卡片自带锚点就以它为准；旧卡没有锚点时按它当前所处位置补一个，
  // 让后续重建至少不会把它丢掉。
  if (card.anchorMessageId) return { card };
  const before = items.slice(0, index).reverse().find((item) => item.messageID);
  return { card: { ...card, anchorMessageId: before?.messageID } };
}

/** 压缩一开始就把 pending 卡片连同锚点记进缓存：切走会重建 state，没有缓存条目它就没处可回。 */
export function recordCompactionStarted<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  items: readonly T[],
): void {
  if (!sessionPath || items.length === 0) return;
  recordCompactionDone(sessionPath, items, items.length - 1, items[items.length - 1] as T);
}

/**
 * Record a finished compaction so its card survives a tab switch (controller
 * state may be rebuilt entirely). The anchor is the message the conversation had
 * reached when the compaction started — it names a real row, so it keeps working
 * no matter how many pages the frontend has loaded.
 */
export function recordCompactionDone<T extends AnchorRowLike>(
  sessionPath: string | undefined,
  items: readonly T[],
  cardIndex: number,
  card: T,
): void {
  // 一个会话只留最新一张：后一次压缩替换前一次，而不是在旁边并列。
  // sidecar 同样只有一条记录，重建时不能把记录已经不描述的旧卡插回来。
  liveCompactionsCache.set(sessionPath ?? "", [entryForCard(items, cardIndex, card) as CompactionCacheEntry<AnchorRowLike>]);
}

// 旧卡片（还没锚点）在重建后补一个锚点，避免它在下一次重建时无位置可用。
export function refreshCompactionAnchors<T extends AnchorRowLike>(
  sessionPath: string,
  items: readonly T[],
): void {
  const cached = liveCompactionsCache.get(sessionPath);
  if (!cached || cached.length === 0) return;
  let changed = false;
  const next = cached.map((entry) => {
    if (entry.card.anchorMessageId) return entry;
    const index = items.findIndex((item) => item.id === entry.card.id);
    if (index < 0) return entry;
    changed = true;
    return entryForCard(items, index, entry.card as T) as CompactionCacheEntry<AnchorRowLike>;
  });
  if (changed) liveCompactionsCache.set(sessionPath, next);
}

function cachedCards<T extends AnchorRowLike>(sessionPath: string | undefined, prevItems: readonly T[]): T[] {
  const cached = liveCompactionsCache.get(sessionPath ?? "");
  if (cached && cached.length > 0) return cached.map((entry) => entry.card as T);
  // 卡片自带会话归属时只取同会话的：重启 / 切回来重建 items 时，prevItems 里的
  // 卡片就是这一张，必须能兜底找回；不同会话的卡片才丢弃，避免串会话。
  // 归属未知（重启早期 meta 还没落地）不能算作别的会话：那种卡片正是本次恢复
  // 刚插进去的，丢掉它就等于重启后永远看不到压缩卡片。
  return prevItems.reduce<T[]>((cards, item, index) => {
    if (item.kind !== "compaction") return cards;
    if (sessionPath && item.sessionPath && item.sessionPath !== sessionPath) return cards;
    cards.push(entryForCard(prevItems, index, item).card as T);
    return cards;
  }, []);
}

// preserveLiveCompactions carries the session's compaction cards across any
// hydrate-driven items rebuild. nextItems already containing a compaction row
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
