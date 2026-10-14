// turn-event-projection-replay-window.test.ts — replay 投影窗口内的 live 事件
// 必须按 seq 排队，而不是绕过去重直接投影：replay 页与页之间落地的 live 事件
// 此前被无条件放行（apply 一次），其 replay 页随后又投影同一 seq（再 apply 一
// 次）——append-only 的 notice 行双份且夹在 replayed tool 行之间错位
// （e18f1f8e 实测）。修复后：窗口内 live 事件入 gapQueue，由 replay 收尾的
// drain 按最终 cursor 判定（seq ≤ cursor = replay 已携带 → 丢弃）。
// 运行：node --import tsx src/__tests__/turn-event-projection-replay-window.test.ts
import assert from "node:assert/strict";
import type { AppBindings } from "../lib/bridge";
import type { TurnEventReplayView } from "../lib/types";

const binding: Partial<AppBindings> = {};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: binding as AppBindings } } } as Window,
});

const { TurnEventProjector } = await import("../lib/turnEventProjection");

// 场景 1：replay 投影期间到达的 live 事件（seq 在 replay 剩余范围内）→ 排队，
// replay 页落地后 drain 按 cursor 丢弃 → handler 只投影一次。
{
  // 两页 replay：第一页立即返回，第二页手动放行（制造页间窗口）。
  const page1: TurnEventReplayView = {
    events: [
      { turnId: "turn-w", seq: 1, status: "in_progress", event: { kind: "turn_started", turnId: "turn-w", status: "in_progress" } },
      { turnId: "turn-w", seq: 2, status: "in_progress", event: { kind: "notice", turnId: "turn-w", status: "in_progress", text: "已记录决策" } },
    ],
    floorSeq: 1, latestSeq: 3, nextAfterSeq: 2, hasMore: true, resetRequired: false,
  };
  let releasePage2!: () => void;
  const page2Gate = new Promise<void>((resolve) => { releasePage2 = resolve; });
  const page2: TurnEventReplayView = {
    events: [
      // seq 3 = 窗口期间 live 直达的同一 notice（replay 页又携带一遍）
      { turnId: "turn-w", seq: 3, status: "in_progress", event: { kind: "notice", turnId: "turn-w", status: "in_progress", text: "已记录决策" } },
    ],
    floorSeq: 1, latestSeq: 3, nextAfterSeq: 3, hasMore: false, resetRequired: false,
  };
  let call = 0;
  binding.TurnEventsForTab = async (_tabId: string, afterSeq: number) => {
    call += 1;
    if (call === 1) return page1;
    await page2Gate;
    void afterSeq;
    return page2;
  };

  const projected: number[] = [];
  const projector = new TurnEventProjector();
  projector.bind((event) => projected.push(event.seq ?? 0));
  // 初始化观察：active turn，replayAfter=0 → 整 turn 重放
  projector.observeRuntime("tab-w", "epoch-w", 3, 0, true, "turn-w");
  // 第一页投影是同步的（projectEnvelope），此处 cursor 已到 2；
  // replay 在飞（页 2 await 中）→ 窗口内的 live notice（seq 3）必须排队
  assert.equal(
    projector.acceptLive("tab-w", { kind: "notice", seq: 3, runtimeEpoch: "epoch-w" }, "epoch-w"),
    false,
    "replay 窗口内的 live 事件应排队而非直接投影",
  );
  releasePage2();
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  assert.deepEqual(projected, [1, 2, 3], "seq 3 只投影一次（replay 页携带，drain 丢弃排队副本）");
}

// 场景 2：窗口内 live 事件恰好衔接 replay 末尾（seq == cursor+1）→ drain 时
// 按序补投影，不丢行。
{
  const single: TurnEventReplayView = {
    events: [
      { turnId: "turn-x", seq: 1, status: "in_progress", event: { kind: "turn_started", turnId: "turn-x", status: "in_progress" } },
      { turnId: "turn-x", seq: 2, status: "in_progress", event: { kind: "text", turnId: "turn-x", status: "in_progress", text: "durable" } },
    ],
    floorSeq: 1, latestSeq: 2, nextAfterSeq: 2, hasMore: false, resetRequired: false,
  };
  binding.TurnEventsForTab = async () => single;
  const projected: number[] = [];
  const projector = new TurnEventProjector();
  projector.bind((event) => projected.push(event.seq ?? 0));
  projector.observeRuntime("tab-x", "epoch-x", 2, 0, true, "turn-x");
  // 窗口期 live 事件 seq 3（快照尚未包含，恰好衔接 replay 末尾）
  assert.equal(projector.acceptLive("tab-x", { kind: "notice", seq: 3, runtimeEpoch: "epoch-x" }, "epoch-x"), false);
  for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
  assert.deepEqual(projected, [1, 2, 3], "衔接 replay 末尾的 live 行在 drain 时按序补投影");
}

// 场景 3：无 seq 的 live 事件在窗口内仍直接放行（不参与 seq 去重，保持旧语义；
// 放行后由调用方 handleWireEvent 正常分发）。
{
  binding.TurnEventsForTab = async () => ({
    events: [], floorSeq: 0, latestSeq: 0, nextAfterSeq: 0, hasMore: false, resetRequired: false,
  });
  const projector = new TurnEventProjector();
  projector.bind(() => {});
  projector.observeRuntime("tab-y", "epoch-y", 0, undefined, true);
  assert.equal(projector.acceptLive("tab-y", { kind: "notice", runtimeEpoch: "epoch-y" }, "epoch-y"), true, "无 seq 事件保持直通");
}

console.log("turn event projection replay-window tests passed");
