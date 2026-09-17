// Run: tsx src/__tests__/replay-page-adopt.test.ts
//
// v3 日志（d873ec5c，全量 dump）定死的残留机制：
//   切回 → reset（items=0）→ 整轮重放开始 → 历史 apply（replace，页行 he:*）
//   落位 → **进行中的重放残余继续投影，在页上重建 a:* 行** → 页行与重放行并存。
//   时序分岔：重放先完成再 apply → replace 丢弃重放行（干净）；
//   apply 先于重放完成 → 重复（"一直在重建"的会话）。
// 修复：页 apply 时 projector.adoptPage —— 终止进行中的 repair（generation++）、
//   序列推进到已知 latest、清滞留队列；后续 live 事件（seq>latest）正常投影。

import type { AppBindings } from "../lib/bridge";

const binding: Partial<AppBindings> = {};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { go: { main: { App: binding as AppBindings } } } as Window,
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

console.log("\nadoptPage halts an in-flight replay and adopts the page's view");

{
  const projector = new TurnEventProjector();
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));
  eq(typeof (projector as unknown as { adoptPage?: unknown }).adoptPage, "function", "projector exposes adoptPage");

  // 重放页挂起：repair 进行中，页面（replace）落位
  let releaseReplay!: (view: unknown) => void;
  binding.TurnEventsForTab = async (_tabId: string, afterSeq: number) => new Promise((resolve) => {
    releaseReplay = (view: unknown) => resolve(view);
    void afterSeq;
  });
  projector.observeRuntime("tab", "epoch-a", 100, 42, true, "turn-x");
  await settle();
  eq(projected.length, 0, "replay pending while the page is applied");

  projector.adoptPage("tab");
  releaseReplay({
    events: [
      { turnId: "turn-x", seq: 43, status: "in_progress", event: { kind: "turn_started", turnId: "turn-x" } },
      { turnId: "turn-x", seq: 44, status: "in_progress", event: { kind: "text", turnId: "turn-x", text: "residual" } },
    ],
    floorSeq: 43, latestSeq: 100, nextAfterSeq: 44, hasMore: true, resetRequired: false, runtimeEpoch: "epoch-a",
  });
  await settle();
  eq(projected.length, 0, "the superseded replay must not project its residual rows");

  // 后续 live 事件（seq > 已知 latest）正常投影
  const liveAccepted = projector.acceptLive("tab", { kind: "text", seq: 101, runtimeEpoch: "epoch-a" }, "epoch-a");
  eq(liveAccepted, true, "live events past the adopted page still flow");
  if (liveAccepted) projected.push(101);
  eq(projected, [101], "only post-page live rows are projected");
}

console.log("\nadoptPage leaves an idle tab intact");

{
  const projector = new TurnEventProjector();
  const projected: number[] = [];
  projector.bind((event) => projected.push(event.seq ?? 0));
  projector.observeRuntime("idle", "epoch-a", 50, 50, false, "turn-y");
  projector.adoptPage("idle");
  const idleAccepted = projector.acceptLive("idle", { kind: "text", seq: 51, runtimeEpoch: "epoch-a" }, "epoch-a");
  eq(idleAccepted, true, "sequence stays monotonic after adopt on an idle tab");
  if (idleAccepted) projected.push(51);
  eq(projected, [51], "no rows lost by the adoption");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
