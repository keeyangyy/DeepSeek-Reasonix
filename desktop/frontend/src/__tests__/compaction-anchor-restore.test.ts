// compaction-anchor-restore.test.ts — 切回（hydrate）后压缩卡片按锚点恢复原位：
// 压缩卡片是 live 事件产物（不持久化），锚点是 anchorUsers（压缩分界前有多少
// 条 user 消息，压缩时写入，后端 sidecar 同名字段）。卡片落在第 anchorUsers+1
// 个 user 行之前，即压缩关闭的那一轮结束处；没有锚点的旧记录落到末尾。
// 注意：liveCompactionsCache 是模块级单例，各场景必须使用独立 sessionPath。
// 运行：pnpm exec tsx src/__tests__/compaction-anchor-restore.test.ts
import { initialState, reducer, type Item } from "../lib/useController";
import type { HistoryMessage } from "../lib/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function userMsg(text: string): HistoryMessage {
  return { role: "user", content: text } as HistoryMessage;
}
function assistantMsg(text: string): HistoryMessage {
  return { role: "assistant", content: text } as HistoryMessage;
}

function compactionCards(items: ReturnType<typeof reducer>["items"]) {
  return items.filter((it) => it.kind === "compaction");
}

console.log("\ncompaction anchor restore");

// 场景 1（核心 bug）：live 压缩 → 又一回合 → 切走切回（controller 重建，
// reset+history）→ 卡片插在压缩发生的位置，而不是消息流最底部。
{
  const SESSION = "t1.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "pressure" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "pressure", messages: 1298, summary: "压一" },
    },
  } as never);
  // 压缩后用户又发了一回合（user append 刷新锚点 → usersAfter=1）
  s = reducer(s, { type: "user", text: "三" } as never);
  // 切走再切回：全新 controller 状态，历史含压缩后完成的回合
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(cards.length === 1, "切回后恰好一张压缩卡片（不重复）");
  const idx = back.items.findIndex((it) => it.kind === "compaction");
  const u3Idx = back.items.findIndex(
    (it) => it.kind === "user" && it.text === "三",
  );
  const a2Idx = back.items.reduce(
    (acc, it, i) => (it.kind === "assistant" && it.text === "答二" ? i : acc),
    -1,
  );
  ok(
    idx === a2Idx + 1 && u3Idx === idx + 1,
    "卡片插在压缩发生的位置（答二之后、新回合之前），不是最底部",
  );
  ok((cards[0] as { summary?: string }).summary === "压一", "摘要内容正确");
}

// 场景 2：压缩后无新回合 → 锚点等于当前 user 总数 → 卡片落在末尾（压缩点就是
// 最新一轮之后）。
{
  const SESSION = "t2.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 3, summary: "压零" },
    },
  } as never);
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(
    cards.length === 1 && back.items[back.items.length - 1].kind === "compaction",
    "无新回合时卡片落在末尾（压缩点就是最新一轮之后）",
  );
}

// 场景 2b：重启后 sidecar 恢复（latest_compaction）→ 卡片插在历史之前。
{
  const SESSION = "t2b.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一"), userMsg("二"), assistantMsg("答二")],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "latest_compaction",
    tabId: SESSION,
    record: { trigger: "manual", messages: 462, summary: "重启恢复" },
  } as never);
  const recovered = s.items[s.items.length - 1];
  ok(
    recovered.kind === "compaction" &&
      (recovered as { summary?: string }).summary === "重启恢复" &&
      s.items[0].kind === "user",
    "无锚点的旧 sidecar 记录恢复后落在末尾，不插到历史顶部",
  );
  // 重复 hydrate（同 summary）不堆叠。
  s = reducer(s, {
    type: "latest_compaction",
    tabId: SESSION,
    record: { trigger: "manual", messages: 462, summary: "重启恢复" },
  } as never);
  ok(compactionCards(s.items).length === 1, "重复 latest_compaction 不重复插卡");
}

// 场景 3：rewind 后页面 user 行与锚点文本不符（同计数、不同轮次）→ 回退末尾，不丢失。
// （注意与场景 7 区分：那是计数越界 → 顶部。）
{
  const SESSION = "t3.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压二" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "三" } as never);
  // rewind 后历史只剩第一回合：锚点（倒数第 1 个 user 之前）越界
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(
    cards.length === 1 &&
      back.items[back.items.length - 1].kind === "compaction",
    "锚点越界回退到末尾且不丢失",
  );
}

// 场景 4：历史产物已含压缩卡片（老格式 role:"compaction"）→ 不叠加（防重复）。
{
  const SESSION = "t4.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压三" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "二" } as never);
  const back = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      {
        role: "compaction",
        trigger: "manual",
        messages: 4,
        summary: "压三",
      } as unknown as HistoryMessage,
      userMsg("二"),
    ],
    seq: 3,
    remote: false,
  } as never);
  ok(compactionCards(back.items).length === 1, "历史已含卡片时不叠加");
}

// 场景 5：同 controller 内 reset（prevItems 携带卡片，实时算锚点）→ history 后归位。
{
  const SESSION = "t5.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
    ],
    seq: 4,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 4, summary: "压四" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "三" } as never);
  // 同 controller 内触发 hydrate（如 resume）：reset 保留卡片，history 重建
  s = reducer(s, { type: "reset" } as never);
  s = reducer(s, { type: "meta", meta: { sessionPath: SESSION } } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  const idx = s.items.findIndex((it) => it.kind === "compaction");
  const u3Idx = s.items.findIndex(
    (it) => it.kind === "user" && it.text === "三",
  );
  ok(
    compactionCards(s.items).length === 1 && idx === u3Idx - 1,
    "同 controller hydrate 后卡片同样归位",
  );
}

// 场景 6：多张卡片 → 各自按锚点归位，互不干扰、不重复。
// 压A 锚点=3、压B 锚点=4；重建历史只有 2 条 user，两个锚点都在窗口之外 →
// 两张卡按发生顺序落在末尾，不会被塞进无关回合。
{
  const SESSION = "t6.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("二"),
      assistantMsg("答二"),
      userMsg("三"),
      assistantMsg("答三"),
    ],
    seq: 6,
    remote: false,
  } as never);
  // 第一张卡片落在"三"回合后，再走一回合；第二张卡片落在"四"回合后无新内容
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "pressure" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "pressure", messages: 10, summary: "压A" },
    },
  } as never);
  s = reducer(s, { type: "user", text: "四" } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 6, summary: "压B" },
    },
  } as never);
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  // 重建历史：压A fold 掉了"二/三"回合（不出现），保留"一"与"四"回合
  back = reducer(back, {
    type: "history",
    messages: [
      userMsg("一"),
      assistantMsg("答一"),
      userMsg("四"),
      assistantMsg("答四"),
    ],
    seq: 4,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  // 一个会话只保留最新一次压缩的卡片：sidecar 也只有一条记录，
  // 旧卡不该在重建时被缓存插回来。
  ok(cards.length === 1, "只恢复最新一张卡片，旧卡片不再泄漏");
  ok(
    (cards[0] as { summary?: string }).summary === "压B",
    "恢复的是最新一次压缩",
  );
  const idxB = back.items.findIndex(
    (it) =>
      it.kind === "compaction" &&
      (it as { summary?: string }).summary === "压B",
  );
  const u4Idx = back.items.findIndex(
    (it) => it.kind === "user" && it.text === "四",
  );
  ok(idxB > u4Idx, "锚点越界时卡片落在末尾");
}

// 场景 7：锚点计数越界（压缩后又聊了多轮，切回页面只含最近几轮）→ 卡片仍按
// anchorUsers 落在页面内的对应轮次边界（分页窗口内的近似位置），不丢失。
{
  const SESSION = "t7.jsonl";
  let s = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  s = reducer(s, {
    type: "history",
    messages: [userMsg("一"), assistantMsg("答一")],
    seq: 2,
    remote: false,
  } as never);
  s = reducer(s, {
    type: "event",
    e: { kind: "compaction_started", compaction: { trigger: "manual" } },
  } as never);
  s = reducer(s, {
    type: "event",
    e: {
      kind: "compaction_done",
      compaction: { trigger: "manual", messages: 2, summary: "压F" },
    },
  } as never);
  // 压缩后又聊了 5 轮：锚点 usersAfter=5
  for (const t of ["二", "三", "四", "五", "六"]) {
    s = reducer(s, { type: "user", text: t } as never);
    s = reducer(s, {
      type: "assistant",
      text: "答" + t,
      reasoning: "",
      streaming: false,
    } as never);
  }
  // 切回：页面只含最近 2 轮（userCount=2 < usersAfter=5）→ 计数越界
  let back = reducer(initialState, {
    type: "meta",
    meta: { sessionPath: SESSION },
  } as never);
  back = reducer(back, {
    type: "history",
    messages: [userMsg("五"), assistantMsg("答五"), userMsg("六"), assistantMsg("答六")],
    seq: 4,
    remote: false,
  } as never);
  const cards = compactionCards(back.items);
  ok(cards.length === 1, "越界场景卡片不丢失");
  const cardIdx = back.items.findIndex((it) => it.kind === "compaction");
  const u6Idx = back.items.findIndex((it) => it.kind === "user" && it.text === "六");
  ok(
    cardIdx >= 0 && cardIdx === u6Idx - 1,
    `分页窗口内卡片紧贴在第 anchorUsers+1 个 user 之前（card=${cardIdx} 六=${u6Idx}）`,
  );
}

// 场景 8：重启后从 sidecar 恢复（latest_compaction）之后，又发生一次 items 重建
// （重复 hydrate / 翻页 replace）→ 卡片必须还在。重启时模块缓存是空的，恢复
// 动作自己必须登记，否则下一次 history_replace 会把刚插好的卡片冲掉。
{
  const SESSION = "t8.jsonl";
  const page: Item[] = [
    { kind: "user", id: "he:u1", text: "一" },
    { kind: "assistant", id: "he:a1", text: "答一", reasoning: "", streaming: false },
    { kind: "user", id: "he:u2", text: "二" },
  ];
  const hydrate = (state: ReturnType<typeof reducer>) =>
    reducer(state, { type: "history_replace", items: page, startTurn: 1, totalTurns: 2, hasOlder: false } as never);
  let s = reducer(initialState, { type: "meta", meta: { sessionPath: SESSION } } as never);
  s = hydrate(s);
  s = reducer(s, {
    type: "latest_compaction",
    tabId: SESSION,
    record: { trigger: "manual", messages: 39, summary: "重启恢复二", anchorUsers: 1 },
  } as never);
  const before = compactionCards(s.items).length;
  s = hydrate(s);
  const after = compactionCards(s.items);
  ok(before === 1 && after.length === 1, `重启恢复后再次 hydrate 卡片仍在（before=${before} after=${after.length}）`);
  const cardIdx = s.items.findIndex((it) => it.kind === "compaction");
  const u2Idx = s.items.findIndex((it) => it.kind === "user" && it.text === "二");
  ok(cardIdx === u2Idx - 1, "且回到原来的轮次边界（第 2 个 user 之前）");
}

// 场景 9：重启早期 state.meta 还没落地（会话路径只在 action 上）→ 恢复的卡片
// 也必须登记进缓存，否则 meta 后到的那次 hydrate 会把它冲掉。
{
  const SESSION = "t9.jsonl";
  const page: Item[] = [
    { kind: "user", id: "he:u1", text: "一" },
    { kind: "assistant", id: "he:a1", text: "答一", reasoning: "", streaming: false },
  ];
  const hydrate = (state: ReturnType<typeof reducer>) =>
    reducer(state, { type: "history_replace", items: page, startTurn: 1, totalTurns: 1, hasOlder: false } as never);
  let s = hydrate(initialState);
  s = reducer(s, {
    type: "latest_compaction",
    tabId: SESSION,
    sessionPath: SESSION,
    record: { trigger: "manual", messages: 39, summary: "重启恢复三", anchorUsers: 1 },
  } as never);
  ok(compactionCards(s.items).length === 1, "meta 未落地时 latest_compaction 仍插入卡片");
  // meta 后到，然后再次 hydrate：此时 sessionPath 有值，只能靠缓存找回。
  s = reducer(s, { type: "meta", meta: { sessionPath: SESSION } } as never);
  s = hydrate(s);
  ok(compactionCards(s.items).length === 1, "meta 后到的 hydrate 不会冲掉卡片（action 的会话路径已登记）");
}

// 场景 10：锚点等于当前 user 总数（压缩就发生在最新一轮之后）→ 卡片落在末尾，
// 也就是用户触发压缩时所处的位置。
{
  const SESSION = "t10.jsonl";
  const page: Item[] = [];
  for (let index = 0; index < 18; index += 1) {
    page.push({ kind: "user", id: `he:u${index}`, text: `问${index}` });
    page.push({ kind: "assistant", id: `he:a${index}`, text: `答${index}`, reasoning: "", streaming: false });
  }
  let s = reducer(initialState, { type: "meta", meta: { sessionPath: SESSION } } as never);
  s = reducer(s, { type: "history_replace", items: page, startTurn: 1, totalTurns: 18, hasOlder: false } as never);
  s = reducer(s, {
    type: "latest_compaction",
    tabId: SESSION,
    sessionPath: SESSION,
    record: { trigger: "manual", messages: 39, summary: "末尾恢复", anchorUsers: 18 },
  } as never);
  const last = s.items[s.items.length - 1];
  ok(last.kind === "compaction", `锚点=user 总数时卡片落在末尾（末条为 ${last.kind}，共 ${s.items.length} 条）`);
}

console.log(`\ncompaction anchor restore: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
