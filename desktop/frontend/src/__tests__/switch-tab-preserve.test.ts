// Run: tsx src/__tests__/switch-tab-preserve.test.ts
//
// 闪烁根因（v4 用户反馈）：侧边栏/标签点击未携带 optimisticTab 时，
// switchTab 的 targetIdentity 为 undefined → sameSession 恒 false →
// preserveTargetSurface=false → 立即 reset（清空 items）→ 页异步落位前的白屏。
// 修复：optimisticTab 缺失时回退用目标 tab 自身保留的 meta 判定——
// 保留该 tab 自己的会话表面总是安全的（页 fingerprint/revision 校验兜底）。

export {};

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {},
});

const { switchTargetIdentity } = await import("../lib/hydrateHistoryApply");

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

const retained = { sessionPath: "D:/sessions/a.jsonl", sessionGeneration: 3 };

console.log("\nswitchTargetIdentity");
{
  eq(switchTargetIdentity(undefined, retained), { sessionPath: retained.sessionPath, sessionGeneration: 3 }, "a click without optimistic metadata falls back to the tab's own identity");
  eq(switchTargetIdentity({ sessionPath: "other.jsonl", sessionGeneration: 9 }, retained), { sessionPath: "other.jsonl", sessionGeneration: 9 }, "explicit optimistic metadata wins over the retained meta");
  eq(switchTargetIdentity(undefined, undefined), undefined, "no optimistic and no retained meta cannot claim sameness");
  eq(switchTargetIdentity(undefined, { sessionGeneration: 3 }), undefined, "a retained meta without sessionPath cannot claim sameness");
}

console.log("\nsameSession implications");
{
  const { sameSessionHydrateIdentity } = await import("../lib/hydrateHistoryApply");
  eq(sameSessionHydrateIdentity(switchTargetIdentity(undefined, retained), retained), true, "a metadata-less click on an open tab preserves its surface (no reset flicker)");
  eq(sameSessionHydrateIdentity(switchTargetIdentity(undefined, retained), { sessionPath: retained.sessionPath, sessionGeneration: 4 }), false, "a generation change on the same path still cannot preserve (rewind/rebind)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
