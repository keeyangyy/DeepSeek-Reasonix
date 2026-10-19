// Run: tsx src/__tests__/steer-overlap-repro.test.ts
//
// 复现并验证「插入消息（steer）后重加载会话，历史行与 live 行共存导致顺序错乱」。
//
// 现场：buildCommit e2d3812 的诊断（reasonix-frontend-diagnostics-dcd768d4）显示
// 用户在 running 会话上重加载后，第一个 assistant 块显示的是 steer 之后的思考，
// 原本那段思考消失；切走再切回（完整重载）才恢复。
//
// 形态：steer 把一轮输出切成多个纯工具轮——assistant 行没有可见正文（live 实测
// length=0），reasoning 在流式中是移动的前缀。于是签名、text 前缀、user 内容、
// messageID 四条去重判据同时失效，页面行与 live 行共存。
//
// 断言落在用户可见结果上：页面已经包含该 turn 时，live 副本必须从移除集合中消失。

import {
  duplicateLiveItemIds,
  itemSignature,
  pageOverlapsLiveContent,
  replaceRemoveIds,
  toolIdentityCoveredLiveItemIds,
} from "../lib/hydrateHistoryApply";
import type { SignatureItem } from "../lib/hydrateHistoryApply";

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

// ── 现场形态 ────────────────────────────────────────────────────────────────
const steerReasoning = "用户 steer: 看完包介绍后，围绕主干这个 loop 去更好地分组，比分层更科学。";

// 一个纯工具轮：assistant 无正文，后面跟着两个工具。
// 页面侧是更早的快照：reasoning 更短；live 侧已增长，且尚未落盘（无 messageID）。
const liveRound: SignatureItem[] = [
  { kind: "assistant", id: "a:turn-7:3", text: "", reasoning: steerReasoning },
  { kind: "tool", id: "call_936d28220c284e1ab89604b8", name: "bash" },
  { kind: "tool", id: "call_2f6f2903747f422b9de94e91", name: "bash" },
];
const pageRound: SignatureItem[] = [
  {
    kind: "assistant",
    id: "he:s20261019-152059.194951500-axon:r0:m12:o0",
    text: "",
    reasoning: "用户 steer: 看完包介绍后，围绕主干这个 loop",
  },
  // history 侧的工具 id 带 he: 命名空间，其余部分与 live 完全相同。
  { kind: "tool", id: "he:call_936d28220c284e1ab89604b8", name: "bash" },
  { kind: "tool", id: "he:call_2f6f2903747f422b9de94e91", name: "bash" },
];

const liveIds = liveRound.map((item) => item.id);

// ── 1. 前提：签名确实不等，说明签名判据在此形态下无从下手 ───────────────────
process.stdout.write("前提\n");
ok(
  itemSignature(pageRound[0]) !== itemSignature(liveRound[0]),
  "同一 turn 的两代 assistant 行签名不等（reasoning 是流式前缀）",
);

// ── 2. 重叠判定：页面已带该 turn 的工具 → 必须判定为重叠 ─────────────────────
process.stdout.write("\n重叠判定\n");
ok(
  pageOverlapsLiveContent(pageRound, liveRound),
  "页面的工具调用已表明它带着该 turn 的输出，应判定为重叠",
);

// ── 3. 移除集合：live 副本必须全部让位 ─────────────────────────────────────
process.stdout.write("\n移除集合（用户可见结果）\n");
// activeTurnId 传 undefined：重载后 live 归属尚未恢复，正是 prefix 兜底失效的现场。
const remove = replaceRemoveIds(pageRound, liveRound, undefined, []);
for (const id of liveIds) {
  ok(remove.includes(id), `live 行 ${id} 应被移除（否则与页面副本共存）`);
}

// ── 4. 工具身份判据本身 ────────────────────────────────────────────────────
process.stdout.write("\n工具身份判据\n");
const covered = toolIdentityCoveredLiveItemIds(pageRound, liveRound);
ok(covered.includes("a:turn-7:3"), "无正文的 assistant 行靠其后相邻工具被识别");
ok(
  covered.includes("call_936d28220c284e1ab89604b8"),
  "live 工具行按同一 toolCallId 让位（跨 he: 命名空间比对）",
);

// ── 5. 对照组：不重叠时不得误删 ────────────────────────────────────────────
process.stdout.write("\n对照组（不得误删）\n");
const otherPage: SignatureItem[] = [
  { kind: "assistant", id: "he:x:r0:m2:o0", text: "", reasoning: "另一轮" },
  { kind: "tool", id: "he:call_other_turn", name: "bash" },
];
ok(
  toolIdentityCoveredLiveItemIds(otherPage, liveRound).length === 0,
  "页面带的是别的 turn 的工具时，live 行不被移除",
);
ok(
  replaceRemoveIds(otherPage, liveRound, undefined, []).filter((id) => liveIds.includes(id)).length === 0,
  "不同 turn 之间不会互相吞并",
);

// 页面完全没有工具时（纯文本轮），既有判据仍须工作。
const textPage: SignatureItem[] = [
  { kind: "assistant", id: "he:x:r0:m13:o0", text: "答案正文", reasoning: steerReasoning },
];
const textLive: SignatureItem[] = [
  { kind: "assistant", id: "a:turn-8:1", text: "答", reasoning: steerReasoning },
];
ok(pageOverlapsLiveContent(textPage, textLive), "对照组：有正文时原有 text 前缀判据照常生效");

// user 行仍然靠内容覆盖移除。
const userPage: SignatureItem[] = [{ kind: "user", id: "he:x:r0:m9:o0", text: "每个包有文档或者介绍吗？" }];
const userLive: SignatureItem[] = [{ kind: "user", id: "u9", text: "每个包有文档或者介绍吗？" }];
ok(
  replaceRemoveIds(userPage, userLive, undefined, []).includes("u9"),
  "对照组：user 行的内容覆盖判据未受影响",
);

// 既有严格签名去重不得被本改动影响到。
process.stdout.write("\n既有判据未回归\n");
const sameLive: SignatureItem = { kind: "assistant", id: "a:turn-1:1", text: "同一句", reasoning: "" };
const samePage: SignatureItem = { kind: "assistant", id: "he:x:r0:m1:o0", text: "同一句", reasoning: "" };
ok(
  duplicateLiveItemIds([samePage], [sameLive]).includes("a:turn-1:1"),
  "签名完全相等时 duplicateLiveItemIds 仍然命中",
);

process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;