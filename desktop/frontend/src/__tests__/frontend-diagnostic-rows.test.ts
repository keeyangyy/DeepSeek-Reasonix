// Run: npx tsx src/__tests__/frontend-diagnostic-rows.test.ts
//
// 诊断增强的自我验证：行描述符必须能表达「谁被匹配到谁」，同时必须满足
// recorder 的 safeToken 契约——超长或含非法字符的字段会被整个丢弃，那时
// 抓取里会静默缺行，比不加诊断更容易误导。
//
// 背景：history_rebase 按 messageID 把 live 段并到页面行。旧描述符只有
// kind.id[.status].<textLen>，既没有 messageID，也把纯工具轮看成「空行」
// （textLen=0），于是「思考块错位」在现场里无从判断。

import {
  describeRow,
  rowSequence,
  rowSlots,
  recordPageDiagnostic,
  recordWireDiagnostic,
} from "../lib/frontendDiagnosticRows";
import { setFrontendDiagnosticSink } from "../lib/frontendDiagnosticBridge";
import type { SignatureItem } from "../lib/hydrateHistoryApply";

let passed = 0;
let failed = 0;
function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}

const TOKEN = /^[a-zA-Z0-9._:-]{1,64}$/;

// ── 1. 描述符必须能区分「纯工具轮」与「有正文轮」 ──────────────────────────
process.stdout.write("行描述符\n");
const toolOnly: SignatureItem = {
  kind: "assistant",
  id: "a:turn-7:0",
  text: "",
  reasoning: "用户 steer: 看完包介绍后，围绕主干这个 loop 去更好地分组",
  messageID: "01M5AC9G48STF2GST7K8SFZVAA",
};
const withText: SignatureItem = {
  kind: "assistant",
  id: "he:s20261019:r0:m12:o0",
  text: "好，现在写回复。",
  reasoning: "",
  messageID: "01M5ACBQ9AQZYH06FKV90MFWMM",
};

const toolDesc = describeRow(toolOnly);
const textDesc = describeRow(withText);
process.stdout.write(`  纯工具轮: ${toolDesc}\n`);
process.stdout.write(`  有正文轮: ${textDesc}\n`);

ok(TOKEN.test(toolDesc), `纯工具轮描述符符合 safeToken（${toolDesc.length} 字符）`);
ok(TOKEN.test(textDesc), `有正文轮描述符符合 safeToken（${textDesc.length} 字符）`);
ok(toolDesc.endsWith(".0.35"), "纯工具轮仍能看出有 reasoning（尾部 textLen.reasoningLen）");
ok(toolDesc !== textDesc, "两类行描述符不同，可区分");
ok(toolDesc.includes("FZVAA"), "描述符带上 messageID 尾段（rebase 的匹配键）");
ok(
  describeRow({ ...toolOnly, messageID: undefined }).includes(".m") === false,
  "无 messageID 时不伪造该段",
);

// ── 2. 最长形态也不能越过 64 字符上限 ──────────────────────────────────────
process.stdout.write("\n长度上限\n");
const worstCase: SignatureItem = {
  kind: "assistant",
  id: "a:" + "x".repeat(60),
  text: "y".repeat(99999),
  reasoning: "z".repeat(99999),
  messageID: "M".repeat(40),
  status: "protocol_failed_and_retried",
} as SignatureItem;
const worst = describeRow(worstCase);
ok(TOKEN.test(worst), `极端形态仍合法（${worst.length} 字符 ≤ 64）`);

// ── 3. 序列编码能暴露顺序 ──────────────────────────────────────────────────
process.stdout.write("\n序列编码\n");
const rows: SignatureItem[] = [
  { kind: "user", id: "u0", text: "q" },
  { kind: "assistant", id: "a0", text: "", reasoning: "r1", messageID: "m1" },
  { kind: "tool", id: "t1", text: "" },
  { kind: "tool", id: "t2", text: "" },
  { kind: "notice", id: "n0", text: "steer" },
  { kind: "assistant", id: "a1", text: "", reasoning: "r2", messageID: "m2" },
];
ok(rowSequence(rows) === "uattna", `序列为 uattna（实际 ${rowSequence(rows)}）`);
ok(TOKEN.test(rowSequence(rows)), "序列本身也是合法 token");
ok(rowSequence(Array.from({ length: 200 }, () => ({ kind: "tool", id: "t", text: "" }))).length <= 60, "长序列被截断到上限内");

// ── 4. 页面行快照要同时给出页面侧与合并侧 ──────────────────────────────────
process.stdout.write("\n页面行快照\n");
const captured: Array<{ source: string; type: string; fields: Record<string, unknown> }> = [];
setFrontendDiagnosticSink((source, type, fields) => {
  captured.push({ source, type, fields: fields as Record<string, unknown> });
});

const pageRows: SignatureItem[] = [
  { kind: "user", id: "he:u", text: "每个包有文档或者介绍吗？" },
  { kind: "assistant", id: "he:a1", text: "", reasoning: "用户问：…", messageID: "m1" },
  { kind: "tool", id: "he:t1", text: "" },
  { kind: "notice", id: "he:n", text: "↪ 你可以看完后…" },
  { kind: "assistant", id: "he:a2", text: "", reasoning: "用户 steer：…", messageID: "m2" },
];
const mergedRows: SignatureItem[] = [...pageRows, { kind: "user", id: "u9", text: "未落盘的插入消息" }];

recordPageDiagnostic("history_replace", { items: mergedRows, currentAssistant: "a:turn-7:1" }, pageRows, []);

const tail = captured.find((event) => event.type === "items.tail");
const page = captured.find((event) => event.type === "history.page-rows");
ok(Boolean(tail), "记录 items.tail（合并后）");
ok(Boolean(page), "记录 history.page-rows（页面侧）");
ok(tail?.fields.total === 6, `合并后行数 6（实际 ${String(tail?.fields.total)}）`);
ok(page?.fields.total === 5, `页面行数 5（实际 ${String(page?.fields.total)}）`);
ok(String(page?.fields.state) === "uatna", `页面序列 uatna（实际 ${String(page?.fields.state)}）`);
ok(String(tail?.fields.state).startsWith("cur:"), "合并事件带当前 assistant 指针");

const allFieldValues = captured.flatMap((event) =>
  Object.entries(event.fields).filter(([key]) => /^r\d$/.test(key)).map(([, value]) => String(value)));
ok(allFieldValues.length > 0 && allFieldValues.every((value) => TOKEN.test(value)), "所有行槽位字段均符合 safeToken");

// ── 5. wire 事件只记录结构性事件，且不记录正文 ──────────────────────────────
process.stdout.write("\nwire 事件\n");
captured.length = 0;
recordWireDiagnostic({ kind: "stream_attempt", turnId: "turn-7", streamAttempt: { id: "sa-2", action: "begin", messageId: "01M5AC9G48STF2GST7K8SFZVAA" } });
recordWireDiagnostic({ kind: "steer", turnId: "turn-7", text: "你可以看完后可以再围绕一下", itemId: "inbox-1" });
recordWireDiagnostic({ kind: "text", turnId: "turn-7", text: "不应记录" });

eqCount(captured.length, 2, "只记录 stream_attempt 与 steer，忽略 text");
const attempt = captured[0];
const steer = captured[1];
ok(attempt?.fields.action === "stream_attempt" && attempt?.fields.status === "begin", "stream_attempt 记录动作与阶段");
ok(String(attempt?.fields.state).startsWith("m") && String(attempt?.fields.state).includes("FZVAA"), "带 messageID 尾段");
ok(steer?.fields.action === "steer" && steer?.fields.sequence === 13, `steer 只记录长度 13（实际 ${String(steer?.fields.sequence)}）`);
ok(
  !JSON.stringify(captured).includes("你可以看完后"),
  "steer 正文未进入抓取",
);
ok(
  !JSON.stringify(captured).includes("不应记录"),
  "text 事件正文未进入抓取",
);

setFrontendDiagnosticSink(() => {});

function eqCount(actual: number, expected: number, label: string) {
  ok(actual === expected, `${label}（实际 ${actual}）`);
}

process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;