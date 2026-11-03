// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/context-session-cache-coverage.test.ts
// The session cache rate must skip calls whose provider omitted cache counters.
// Counting them as misses is why a ModelScope model behind AxonHub showed 0%;
// the coverage fraction keeps a partial rate from being read as a global one.

import { contextSessionCache } from "../lib/contextSessionCache";

let passed = 0;
let failed = 0;
function ok(value: boolean, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

console.log("\nSession cache coverage");

// Nothing reported: the panel must say "not reported" rather than 0%.
{
  const r = contextSessionCache(
    {
      sessionCacheHitTokens: 0,
      sessionCacheMissTokens: 16_049_924,
      sessionReportedCacheHitTokens: 0,
      sessionReportedCacheMissTokens: 0,
    },
    undefined,
    undefined,
  );
  ok(r.hit === 0 && r.miss === 0, "未上报时不产生命中/未命中");
  ok(r.coverage === 0, "未上报时覆盖率为 0");
}

// Fully reported: rate and coverage both come from the reported pair.
{
  const r = contextSessionCache(
    {
      sessionCacheHitTokens: 900,
      sessionCacheMissTokens: 100,
      sessionReportedCacheHitTokens: 900,
      sessionReportedCacheMissTokens: 100,
    },
    undefined,
    undefined,
  );
  ok(r.hit === 900 && r.miss === 100, "全部上报时沿用上报对");
  ok(r.coverage === 1, "全部上报时覆盖率为 100%");
}

// Mixed session (the real case): 99.5% over the reported part, 2% of prompt
// volume unreported. The rate must not absorb the silent calls.
{
  const r = contextSessionCache(
    {
      sessionCacheHitTokens: 619_435_008,
      sessionCacheMissTokens: 19_077_460,
      sessionReportedCacheHitTokens: 619_435_008,
      sessionReportedCacheMissTokens: 3_027_372,
    },
    undefined,
    undefined,
  );
  const rate = r.hit / (r.hit + r.miss);
  ok(r.hit + r.miss === 622_462_380, "命中率只算已上报部分");
  ok(Math.abs(rate - 0.99514) < 1e-4, "混合会话命中率约 99.5%，不被未上报拉低");
  ok(Math.abs(r.coverage - 0.9748) < 1e-3, "覆盖率为已上报 token 占比");
  ok(r.coverage >= 0.9, "覆盖率高于 90% 时不显示覆盖提示");
}

// Low coverage: the fraction stays available so the UI can caption the rate.
{
  const r = contextSessionCache(
    {
      sessionCacheHitTokens: 9_000,
      sessionCacheMissTokens: 31_000,
      sessionReportedCacheHitTokens: 9_000,
      sessionReportedCacheMissTokens: 1_000,
    },
    undefined,
    undefined,
  );
  ok(r.coverage < 0.9, "覆盖率低于 90% 时可供 UI 提示");
  ok(Math.abs(r.coverage - 0.25) < 1e-6, "覆盖率 = 已上报 / 全部 prompt");
}

// Before the panel refreshes, fall back to live counters (no marker available).
{
  const r = contextSessionCache(null, { cacheHitTokens: 70, cacheMissTokens: 30 }, undefined);
  ok(r.hit === 70 && r.miss === 30, "面板未刷新时回退实时计数");
  ok(r.coverage === 1, "回退路径不做覆盖率折扣");
}

// Legacy telemetry: panel has figures but no reported pair at all.
{
  const r = contextSessionCache({ sessionCacheHitTokens: 0, sessionCacheMissTokens: 5000 }, undefined, undefined);
  ok(r.hit === 0 && r.miss === 0, "旧数据无上报标记时视为未上报");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
