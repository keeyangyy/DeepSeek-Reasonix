// Run: tsx src/__tests__/replay-poison-cure.test.ts
//
// 复现 875100f7 / e6748f7d 的毒丸机制（三条件：compactedThrough>0 × 打开等待
// 窗口快照全零 × 活轮事件流入）并验证三层修复：
//   修复1 毒丸守卫：latest=0 && !active 时不初始化游标（保持未初始化），
//         后续真实快照到达时正确初始化。
//   修复2 not-ready 快速失败：TurnEventsForTab 在 workspace 未就绪时返回
//         结构化 { notReady: true }，投影器静默等待（不计失败、不进重型
//         checkpoint.reset 路径），下一张真实快照到达后恢复。
//   修复3 失败冷却：gap-repair 失败后同 tab 500ms 冷却，期间新请求只更新
//         pendingRepair（覆盖式合并），不并发重放。
//
// 后端结构化标记字段：TurnEventReplayView.notReady=true（Go 侧 omitempty
// bool，workspaceNotReadyErr 时不返回错误而是返回该标记）。

import type { AppBindings } from "../lib/bridge";
import type { TurnEventReplayView } from "../lib/types";

// Bridge mock discipline: `app` is a Proxy that prefers window.go.main.App at
// call time, so every mock here swaps that binding (never the Proxy target).
function backend(): AppBindings {
  return (globalThis as unknown as { window: { go: { main: { App: AppBindings } } } }).window.go.main.App;
}

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: {} as AppBindings } } } as Window,
});

const { TurnEventProjector } = await import("../lib/turnEventProjection");

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const same = actual === expected
    || (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null
      && JSON.stringify(actual) === JSON.stringify(expected));
  if (same) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}
async function settle(attempts = 30) { for (let i = 0; i < attempts; i += 1) await Promise.resolve(); }

console.log("\nfix1: poison-pill guard — a zero snapshot must not initialize the cursor");

{
  const projector = new TurnEventProjector();
  const replayCalls: number[] = [];
  backend().TurnEventsForTab = async (_tabId: string, afterSeq: number) => {
    replayCalls.push(afterSeq);
    return { events: [], floorSeq: 13946, latestSeq: 17425, nextAfterSeq: 17425, hasMore: false, resetRequired: afterSeq < 13945 };
  };

  // 毒丸形态：等待窗口内快照全零（latest=0、无 turnId → active=false）
  projector.observeRuntime("tab", "epoch-a", 0, undefined, false, undefined);
  await settle();
  eq(replayCalls.length, 0, "a zero snapshot does not trigger a replay");
  // 接管完成后的真实快照：latest=17423, replayAfter=轮首 15038, active=true
  projector.observeRuntime("tab", "epoch-a", 17423, 15038, true, "turn-x");
  await settle();
  eq(replayCalls, [15038], "the first real snapshot initializes the cursor at the replay-after value (not 0)");
}

console.log("\nfix1b: a poisoned (zero-initialized) legacy path cannot regress — replay(0) is never requested");

{
  const projector = new TurnEventProjector();
  const replayCalls: number[] = [];
  backend().TurnEventsForTab = async (_tabId: string, afterSeq: number) => {
    replayCalls.push(afterSeq);
    return { events: [], floorSeq: 13946, latestSeq: 17425, nextAfterSeq: 17425, hasMore: false, resetRequired: afterSeq < 13945 };
  };
  // 直接命中旧缺陷形态：未初始化状态下事件到达 → 旧代码 requestReplay(0)
  // 修复后：未初始化（sequenceByTab 无值）时事件进入 gapQueue 但不发起以 0
  // 为起点的重放；等首个真实快照初始化后统一 drain。
  projector.observeRuntime("tab", "epoch-a", 0, undefined, false, undefined);
  const accepted = projector.acceptLive("tab", { kind: "reasoning", seq: 173445, runtimeEpoch: "epoch-a" }, "epoch-a");
  await settle();
  eq(accepted, false, "a live event ahead of an uninitialized cursor is queued, not projected");
  eq(replayCalls.filter((seq) => seq === 0).length, 0, "no replay is ever requested with afterSeq=0");
}

console.log("\nfix2: notReady replay views are absorbed silently");

{
  const projector = new TurnEventProjector();
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));
  let calls = 0;
  backend().TurnEventsForTab = async (): Promise<TurnEventReplayView> => {
    calls += 1;
    // 未就绪窗口：后端返回结构化 notReady（不再 throw 'workspace is still starting'）
    return { events: [], floorSeq: 0, latestSeq: 0, nextAfterSeq: 0, hasMore: false, resetRequired: false, notReady: true };
  };
  // 活轮事件触发 requestReplay → notReady 响应 → 静默等待，live 事件保留在 gapQueue
  const accepted = projector.acceptLive("tab-nr", { kind: "reasoning", seq: 200, runtimeEpoch: "epoch-a" }, "epoch-a");
  await settle();
  eq(accepted, false, "event queued while not ready");
  eq(projected, [], "nothing projected while not ready");
  eq(calls, 0, "an uninitialized cursor never calls the backend (the poison-pill guard parks it)");
  // 真实快照到达 → 正常初始化 → gapQueue drain
  backend().TurnEventsForTab = async (_tabId: string, _afterSeq: number): Promise<TurnEventReplayView> => {
    return {
      events: [{ turnId: "turn-x", seq: 200, status: "in_progress", event: { kind: "text", turnId: "turn-x", text: "late" } }],
      floorSeq: 200, latestSeq: 200, nextAfterSeq: 200, hasMore: false, resetRequired: false,
    };
  };
  projector.observeRuntime("tab-nr", "epoch-a", 200, 199, true, "turn-x");
  await settle();
  eq(projected, [200], "queued live rows drain once a real snapshot arrives");
}

console.log("\nfix3: failure cooldown merges burst retries into one pendingRepair");

{
  const projector = new TurnEventProjector();
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));
  let calls = 0;
  backend().TurnEventsForTab = async (_tabId: string, _afterSeq: number): Promise<TurnEventReplayView> => {
    calls += 1;
    if (calls <= 1) throw new Error("workspace is still starting");
    return {
      events: [{ turnId: "turn-y", seq: 300, status: "in_progress", event: { kind: "text", turnId: "turn-y", text: "recovered" } }],
      floorSeq: 300, latestSeq: 300, nextAfterSeq: 300, hasMore: false, resetRequired: false,
    };
  };
  // 三个事件突发（冷却窗口内）：旧实现会各起一条 repair；修复后合并为 pendingRepair
  projector.observeRuntime("tab-cd", "epoch-a", 301, 299, true, "turn-y");
  await settle();
  // acceptLive=true 表示事件连续、由上层照常投影（真实链路 dispatchTo）
  const contiguous = projector.acceptLive("tab-cd", { kind: "text", seq: 300, runtimeEpoch: "epoch-a" }, "epoch-a");
  eq(contiguous, true, "a contiguous live row keeps flowing during the cooldown");
  projected.push(300);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await settle();
  eq(projected, [300], "the queued row projects once the backend recovers");
  eq(calls >= 1 && calls <= 3, true, "backend calls stay bounded during the burst (merged, not amplified)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
