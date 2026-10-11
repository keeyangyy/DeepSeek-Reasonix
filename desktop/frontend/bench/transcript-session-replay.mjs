import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = !process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === ".pw-browsers"
  ? path.join(frontendDir, ".pw-browsers")
  : process.env.PLAYWRIGHT_BROWSERS_PATH;

const toolNames = ["bash", "read_file", "todo_write", "web_search", "ask", "task", "write_file", "edit_file", "context_budget", "subagent"];

function syntheticHistory() {
  const messages = [{ role: "system", content: "synthetic replay system message" }];
  let call = 0;
  let assistant = 0;
  const askCalls = new Set([0, 68, 136, 204, 272, 340]);
  for (let turn = 0; turn < 12; turn += 1) {
    messages.push({ role: "user", content: `第 ${turn + 1} 个合成问题：检查长会话、工具顺序和切换。` });
    if (turn === 2 || turn === 7) messages.push({ role: "phase", content: `阶段 ${turn + 1}：整理中` });
    if (turn === 5) messages.push({ role: "notice", level: "info", content: "合成回放提示" });
    if (turn === 9) messages.push({ role: "compaction", trigger: "auto", messages: 42, summary: "合成压缩摘要" });
    for (let withinTurn = 0; withinTurn < 29; withinTurn += 1) {
      const hasTool = call < 341;
      const name = hasTool ? (askCalls.has(call) ? "ask" : toolNames[(call * 7) % toolNames.length]) : undefined;
      const toolID = hasTool ? `fixture-call-${call}` : undefined;
      const toolCalls = hasTool ? [{ id: toolID, name, arguments: "{}" }] : [];
      messages.push({
        role: "assistant",
        content: `合成回复 ${assistant}：用于回放长会话中的文本和工具顺序。`,
        reasoning: assistant % 3 === 0 ? `合成思考段 ${assistant}` : undefined,
        toolCalls,
      });
      assistant += 1;
      if (hasTool) {
        messages.push({ role: "tool", toolCallId: toolID, toolName: name, content: `合成工具结果 ${call}` });
        call += 1;
      }
    }
  }
  // Four unmatched legacy results exercise the history converter's orphan path.
  for (let index = 0; index < 4; index += 1) {
    messages.push({ role: "tool", toolCallId: `fixture-orphan-${index}`, toolName: "bash", content: "orphan result" });
  }
  return { messages, source: "synthetic", toolCalls: call };
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (part?.type === "image_url" || part?.type === "image") return "[图片]";
    return "";
  }).join("\n");
}

function readRealSession(filePath) {
  const records = [];
  const toolIDs = new Map();
  let nextID = 0;
  let toolCalls = 0;
  const idFor = (source) => {
    if (!source) return `replay-call-${++nextID}`;
    if (!toolIDs.has(source)) toolIDs.set(source, `replay-call-${++nextID}`);
    return toolIDs.get(source);
  };
  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { continue; } // Ignore a concurrently appended partial tail.
    if (raw.role === "system") {
      records.push({ role: "system", content: "" });
      continue;
    }
    if (raw.role === "user") {
      records.push({ role: "user", content: textContent(raw.content), createdAt: raw.createdAt });
      continue;
    }
    if (raw.role === "assistant") {
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      const toolCallsForMessage = calls.map((entry) => {
        const id = idFor(entry.id);
        const name = String(entry.name ?? "tool");
        toolCalls += 1;
        return { id, name, arguments: "{}" };
      });
      records.push({
        role: "assistant",
        content: textContent(raw.content),
        reasoning: raw.reasoning_content ? "[思考内容已在回放中隐藏]" : undefined,
        workDurationMs: raw.workDurationMs,
        toolCalls: toolCallsForMessage,
      });
      continue;
    }
    if (raw.role === "tool") {
      records.push({
        role: "tool",
        toolCallId: raw.tool_call_id ? idFor(raw.tool_call_id) : undefined,
        toolName: String(raw.name ?? "tool"),
        content: "[工具输出已在回放中隐藏]",
      });
    }
  }
  return { messages: records, source: "real-session-read-only", toolCalls };
}

function selectedHistory() {
  const filePath = process.env.REASONIX_TEST_SESSION_REPLAY_PATH?.trim();
  if (!filePath) return syntheticHistory();
  if (!existsSync(filePath)) throw new Error("REASONIX_TEST_SESSION_REPLAY_PATH does not exist");
  return readRealSession(filePath);
}

function proseFromHistory(messages) {
  const candidates = messages
    .filter((message) => message.role === "assistant" && typeof message.content === "string")
    .map((message) => message.content.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim())
    .filter((text) => Array.from(text).length >= 40);
  return candidates.at(-1) ?? "连续文本流用于检查会话正文更新顺序和版面稳定性。";
}

function takeCodePoints(text, count) {
  return Array.from(text).slice(0, count).join("");
}

function splitText(text, pattern) {
  const chars = Array.from(text);
  const chunks = [];
  for (let offset = 0, part = 0; offset < chars.length; part += 1) {
    const size = pattern[part % pattern.length];
    chunks.push(chars.slice(offset, offset + size).join(""));
    offset += size;
  }
  return chunks;
}

async function sendEventsWithPaint(page, tabId, events) {
  return page.evaluate(async ({ tabId, events }) => {
    const accepted = [];
    const renderedPrefixChecks = [];
    let expectedLiveText = "";
    const stablePrefix = "用户选择结束测试。收尾：";
    for (const event of events) {
      accepted.push(window.reasonixReplayProbe.sendLive(tabId, event));
      if (event.kind === "text") expectedLiveText += event.text;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (event.kind !== "text") continue;
      const state = window.reasonixReplayProbe.snapshot(tabId);
      const renderedTail = document.querySelector(".transcript__resident-tail")?.textContent ?? "";
      renderedPrefixChecks.push({
        stateMatches: state?.liveText === expectedLiveText,
        visibleMatches: !expectedLiveText.includes(stablePrefix) || renderedTail.includes(stablePrefix),
      });
    }
    return { accepted, renderedPrefixChecks };
  }, { tabId, events });
}

const server = await createServer({
  root: frontendDir,
  configFile: path.join(frontendDir, "vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;

try {
  const history = selectedHistory();
  const askCalls = history.messages.reduce((count, message) => count + (message.role === "assistant"
    ? (message.toolCalls ?? []).filter((call) => call.name === "ask").length
    : 0), 0);
  assert.ok(history.messages.length >= 650, `long replay history has ${history.messages.length} messages`);
  assert.ok(history.toolCalls >= 300, `mixed history has ${history.toolCalls} tool calls`);
  assert.ok(askCalls >= 5, `history has ${askCalls} Ask tool calls`);

  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose its local port");
  const { chromium } = await import("playwright");
  const launchOptions = { headless: true };
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  if (!existsSync(chromium.executablePath()) && process.platform === "win32" && existsSync(edge)) {
    launchOptions.executablePath = edge;
  }
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/bench/transcript-session-replay.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);

  const patterns = [[1, 2, 5, 13], [2, 7, 1, 8], [3, 1, 8, 2]];
  for (let scenario = 0; scenario < patterns.length; scenario += 1) {
    const tabA = `session-a-${scenario}`;
    const tabB = `session-b-${scenario}`;
    const epochA = `epoch-a-${scenario}`;
    const epochB = `epoch-b-${scenario}`;
    const turnId = `live-turn-${scenario}`;
    await page.evaluate(({ tabId, messages, epoch }) => window.reasonixReplayProbe.loadHistory(tabId, messages, epoch), {
      tabId: tabA, messages: history.messages, epoch: epochA,
    });
    await page.waitForSelector(".transcript__projection");
    const base = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabA);
    assert.ok(base && base.itemCount > 600, `scenario ${scenario}: production history converter creates a long transcript`);
    assert.equal(base.uniqueItemIds, base.itemCount, `scenario ${scenario}: restored row identities stay unique`);
    assert.ok(base.kinds.user >= 12 && base.kinds.tool > 300 && base.kinds.assistant > 300,
      `scenario ${scenario}: mixed history retains user, assistant, and tool rows`);
    if (history.source === "synthetic") {
      assert.ok(base.kinds.notice >= 1 && base.kinds.compaction >= 1 && base.kinds.phase >= 1,
        `scenario ${scenario}: synthetic history also covers notice, compaction, and phase rows`);
    }

    await page.evaluate(({ tabId, epoch, turnId }) => window.reasonixReplayProbe.sendLive(tabId, {
      kind: "turn_started", turnId, seq: 1, status: "in_progress", runtimeEpoch: epoch,
    }), { tabId: tabA, epoch: epochA, turnId });
    const prelude = `用户选择结束测试。收尾：${takeCodePoints(proseFromHistory(history.messages), 96)}`;
    let seq = 2;
    const prefixEvents = splitText(prelude, patterns[scenario]).map((text) => ({
      kind: "text", text, seq: seq++, turnId, status: "in_progress", runtimeEpoch: epochA,
    }));
    prefixEvents.splice(Math.min(2, prefixEvents.length), 0, {
      kind: "reasoning", reasoning: "先核对当前会话，再按顺序收尾。", seq: seq++, turnId, status: "in_progress", runtimeEpoch: epochA,
    });
    prefixEvents.forEach((event, index) => { event.seq = index + 2; });
    seq = prefixEvents.length + 2;
    const prefixRun = scenario === 0
      ? await sendEventsWithPaint(page, tabA, prefixEvents)
      : { accepted: await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), { tabId: tabA, events: prefixEvents }) };
    assert.ok(prefixRun.accepted.every(Boolean), `scenario ${scenario}: in-order reasoning and text chunks are accepted`);
    if (scenario === 0) {
      const stateMismatches = prefixRun.renderedPrefixChecks.filter((check) => !check.stateMatches).length;
      const visibleMismatches = prefixRun.renderedPrefixChecks.filter((check) => !check.visibleMatches).length;
      assert.equal(stateMismatches, 0, "each live text frame preserves the complete received text in state");
      assert.equal(visibleMismatches, 0, "each rendered stream frame retains the visible opening phrase");
    }

    const dispatchSeq = seq;
    const askSeq = dispatchSeq + 1;
    const askID = `live-ask-prompt-${scenario}`;
    const toolID = "replay-live-ask";
    await page.evaluate((tabId) => window.reasonixReplayProbe.deferReplay(tabId), tabA);
    const askAccepted = await page.evaluate(({ tabId, event }) => window.reasonixReplayProbe.sendLive(tabId, event), {
      tabId: tabA,
      event: {
        kind: "ask_request",
        ask: { id: askID, questions: [{ id: `question-${scenario}`, prompt: "是否继续？", multi: false, options: [{ label: "继续" }, { label: "结束" }] }] },
        seq: askSeq, turnId, status: "waiting_user", runtimeEpoch: epochA,
      },
    });
    assert.equal(askAccepted, false, `scenario ${scenario}: Ask arriving across a sequence gap waits for repair`);
    await page.waitForFunction((tabId) => window.reasonixReplayProbe.replayCalls(tabId) === 1, tabA);

    const otherID = (id) => `other-${scenario}-${id}`;
    const otherHistory = history.messages.map((message, index) => ({
      ...message,
      content: typeof message.content === "string" ? `另一个会话 ${index}：${message.content}` : message.content,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, id: otherID(call.id) })),
      toolCallId: message.toolCallId ? otherID(message.toolCallId) : undefined,
    }));
    await page.evaluate(({ tabId, messages, epoch }) => window.reasonixReplayProbe.loadHistory(tabId, messages, epoch), {
      tabId: tabB, messages: otherHistory, epoch: epochB,
    });
    const baseB = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabB);
    assert.ok(baseB && baseB.itemCount > 600, `scenario ${scenario}: the switched-to session is also a long transcript`);
    assert.equal(baseB.uniqueItemIds, baseB.itemCount, `scenario ${scenario}: the second long session has unique row identities`);
    const otherTurn = `other-turn-${scenario}`;
    const otherEvents = [
      { kind: "turn_started", turnId: otherTurn, seq: 1, status: "in_progress", runtimeEpoch: epochB },
      { kind: "text", text: "切到另一个会话后，活动仍属于它。", seq: 2, turnId: otherTurn, status: "in_progress", runtimeEpoch: epochB },
      { kind: "tool_dispatch", tool: { id: `other-live-tool-${scenario}`, name: "read_file", args: "{}", readOnly: true }, seq: 3, turnId: otherTurn, status: "in_progress", runtimeEpoch: epochB },
      { kind: "tool_result", tool: { id: `other-live-tool-${scenario}`, name: "read_file", output: "[工具输出已隐藏]" }, seq: 4, turnId: otherTurn, status: "in_progress", runtimeEpoch: epochB },
      { kind: "message", text: "另一个会话完成。", seq: 5, turnId: otherTurn, status: "completed", runtimeEpoch: epochB },
      { kind: "turn_done", seq: 6, turnId: otherTurn, status: "completed", runtimeEpoch: epochB },
    ];
    const otherAccepted = await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
      tabId: tabB, events: otherEvents,
    });
    assert.ok(otherAccepted.every(Boolean), `scenario ${scenario}: background-tab events stay on their owner`);

    const replayPage = {
      events: [{
        turnId,
        seq: dispatchSeq,
        status: "in_progress",
        runtimeEpoch: epochA,
        event: { kind: "tool_dispatch", tool: { id: toolID, name: "ask", args: "{}", readOnly: true } },
      }],
      floorSeq: 1,
      latestSeq: dispatchSeq,
      nextAfterSeq: dispatchSeq,
      hasMore: false,
      resetRequired: false,
      runtimeEpoch: epochA,
    };
    await page.evaluate(({ tabId, page }) => window.reasonixReplayProbe.releaseReplay(tabId, page), { tabId: tabA, page: replayPage });
    await page.waitForFunction((tabId) => window.reasonixReplayProbe.snapshot(tabId)?.askPending === true, tabA);
    const pendingA = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabA);
    assert.equal(pendingA.tools.filter((tool) => tool.id === toolID).length, 1, `scenario ${scenario}: repaired Ask dispatch appears once`);
    assert.equal(pendingA.tools.find((tool) => tool.id === toolID)?.status, "running");
    assert.ok(pendingA.assistantLengths.some((length) => length > 0), `scenario ${scenario}: text before Ask stays in the transcript`);

    await page.evaluate((tabId) => window.reasonixReplayProbe.switchTab(tabId), tabA);
    const duplicateAsk = await page.evaluate(({ tabId, event }) => window.reasonixReplayProbe.sendLive(tabId, event), {
      tabId: tabA,
      event: {
        kind: "ask_request",
        ask: { id: askID, questions: [{ id: `question-${scenario}`, prompt: "是否继续？", multi: false, options: [{ label: "继续" }] }] },
        seq: askSeq, turnId, status: "waiting_user", runtimeEpoch: epochA,
      },
    });
    assert.equal(duplicateAsk, false, `scenario ${scenario}: duplicate Ask sequence is discarded`);

    const answerSeq = askSeq + 1;
    await page.evaluate(({ tabId, events }) => events.forEach((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
      tabId: tabA,
      events: [
        { kind: "prompt_answered", itemId: askID, seq: answerSeq, turnId, status: "in_progress", runtimeEpoch: epochA },
        { kind: "tool_result", tool: { id: toolID, name: "ask", output: "用户选择结束测试。" }, seq: answerSeq + 1, turnId, status: "in_progress", runtimeEpoch: epochA },
      ],
    });
    const parallelA = `parallel-bash-${scenario}`;
    const parallelB = `parallel-read-${scenario}`;
    const parallelEvents = [
      { kind: "tool_dispatch", tool: { id: parallelA, name: "bash", args: "Get-Location", readOnly: false } },
      { kind: "tool_dispatch", tool: { id: parallelB, name: "read_file", args: "README.md", readOnly: true } },
      { kind: "tool_result", tool: { id: `unknown-${scenario}`, name: "bash", output: "迟到的未知结果" } },
      { kind: "tool_result", tool: { id: parallelB, name: "read_file", output: "[工具输出已隐藏]" } },
      { kind: "tool_result", tool: { id: parallelA, name: "bash", output: "[工具输出已隐藏]" } },
    ].map((event, index) => ({ ...event, seq: answerSeq + 2 + index, turnId, status: "in_progress", runtimeEpoch: epochA }));
    const parallelAccepted = await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
      tabId: tabA, events: parallelEvents.slice(0, 3),
    });
    assert.ok(parallelAccepted.every(Boolean), `scenario ${scenario}: parallel tool events stay in sequence`);
    const afterUnknownResult = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabA);
    assert.equal(afterUnknownResult.tools.find((tool) => tool.id === parallelA)?.status, "running",
      `scenario ${scenario}: an unknown explicit result cannot settle another running tool`);
    assert.equal(afterUnknownResult.tools.find((tool) => tool.id === parallelB)?.status, "running",
      `scenario ${scenario}: an unknown explicit result leaves every parallel tool untouched`);
    const outOfOrderResultsAccepted = await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
      tabId: tabA, events: parallelEvents.slice(3),
    });
    assert.ok(outOfOrderResultsAccepted.every(Boolean), `scenario ${scenario}: out-of-order parallel results are accepted by their IDs`);
    const afterParallelResults = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabA);
    assert.equal(afterParallelResults.tools.find((tool) => tool.id === parallelA)?.status, "done");
    assert.equal(afterParallelResults.tools.find((tool) => tool.id === parallelB)?.status, "done");
    const continuation = `继续收尾。${takeCodePoints(proseFromHistory(history.messages), 72)}测试结束，完整总结。`;
    const continuationEvents = splitText(continuation, patterns[(scenario + 1) % patterns.length]).map((text, index) => ({
      kind: "text", text, seq: answerSeq + 2 + parallelEvents.length + index, turnId, status: "in_progress", runtimeEpoch: epochA,
    }));
    const continuationStartSeq = answerSeq + 2 + parallelEvents.length + continuationEvents.length;
    continuationEvents.push({
      kind: "message", text: continuation, reasoning: "", seq: continuationStartSeq, turnId, status: "completed", runtimeEpoch: epochA,
    });
    continuationEvents.push({
      kind: "turn_done", seq: continuationStartSeq + 1, turnId, status: "completed", runtimeEpoch: epochA,
    });
    const finalAccepted = await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
      tabId: tabA, events: continuationEvents,
    });
    assert.ok(finalAccepted.every(Boolean), `scenario ${scenario}: post-Ask text chunks and turn end stay ordered`);

    const finalA = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabA);
    const finalB = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), tabB);
    assert.equal(finalA.uniqueItemIds, finalA.itemCount, `scenario ${scenario}: no duplicate transcript item ids after repair and resume`);
    assert.equal(finalA.tools.filter((tool) => tool.id === toolID).length, 1, `scenario ${scenario}: Ask card is not duplicated`);
    assert.equal(finalA.tools.find((tool) => tool.id === toolID)?.status, "done");
    assert.equal(finalA.askPending, false);
    assert.ok(finalA.continuationAfterAsk, `scenario ${scenario}: final assistant reply remains after the Ask tool row`);
    assert.ok(finalB.itemCount > baseB.itemCount, `scenario ${scenario}: the second session's own events extend its long history`);
    assert.equal(finalB.tools.some((tool) => tool.id === toolID || tool.id === parallelA || tool.id === parallelB), false,
      `scenario ${scenario}: tools from the first session never leak into the second`);
    assert.equal(finalB.tools.find((tool) => tool.id === `other-live-tool-${scenario}`)?.status, "done",
      `scenario ${scenario}: the switched-to session's own tool lifecycle completes`);

    await page.waitForFunction(() => document.querySelector(".transcript__resident-tail")?.textContent?.includes("测试结束，完整总结。"));
    const rendered = await page.locator(".transcript__projection").evaluate((projection) => ({
      completedBlocks: Number(projection.getAttribute("data-transcript-completed-blocks") ?? 0),
      mountedBlocks: Number(projection.getAttribute("data-transcript-mounted-blocks") ?? 0),
      hasFinalText: projection.textContent?.includes("测试结束，完整总结。") ?? false,
    }));
    assert.ok(rendered.completedBlocks > 0 && rendered.mountedBlocks > 0 && rendered.hasFinalText,
      `scenario ${scenario}: the real Transcript renders the repaired final tail`);
    process.stdout.write(`  PASS  long ${history.source} transcript replay, chunk pattern ${patterns[scenario].join("/")} (items=${finalA.itemCount}, tools=${finalA.tools.length}, paired long-session switch)\n`);
  }

  const raceTab = "session-generation-race";
  const oldEpoch = "session-generation-old";
  const newEpoch = "session-generation-new";
  const oldTurn = "session-generation-old-turn";
  const newTurn = "session-generation-new-turn";
  await page.evaluate(({ tabId, messages, epoch }) => window.reasonixReplayProbe.loadHistory(tabId, messages, epoch, 0), {
    tabId: raceTab,
    messages: [{ role: "user", content: "旧会话内容标记" }, { role: "assistant", content: "旧会话已开始" }],
    epoch: oldEpoch,
  });
  await page.evaluate(({ tabId, events }) => events.forEach((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
    tabId: raceTab,
    events: [
      { kind: "turn_started", turnId: oldTurn, seq: 1, status: "in_progress", runtimeEpoch: oldEpoch },
      { kind: "text", text: "旧会话流内容", seq: 2, turnId: oldTurn, status: "in_progress", runtimeEpoch: oldEpoch },
    ],
  });
  await page.evaluate((tabId) => window.reasonixReplayProbe.deferReplay(tabId), raceTab);
  const oldGapAccepted = await page.evaluate(({ tabId, event }) => window.reasonixReplayProbe.sendLive(tabId, event), {
    tabId: raceTab,
    event: {
      kind: "tool_dispatch",
      tool: { id: "stale-generation-tool", name: "bash", args: "old", readOnly: false },
      seq: 4, turnId: oldTurn, status: "in_progress", runtimeEpoch: oldEpoch,
    },
  });
  assert.equal(oldGapAccepted, false, "old-generation gap waits for its delayed replay");
  await page.waitForFunction((tabId) => window.reasonixReplayProbe.replayCalls(tabId) === 1, raceTab);
  await page.evaluate(({ tabId, messages, epoch, generation }) => window.reasonixReplayProbe.replaceHistory(tabId, messages, epoch, generation), {
    tabId: raceTab,
    messages: [{ role: "user", content: "新会话内容标记" }, { role: "assistant", content: "新会话已开始" }],
    epoch: newEpoch,
    generation: 1,
  });
  const newGenerationAccepted = await page.evaluate(({ tabId, events }) => events.map((event) => window.reasonixReplayProbe.sendLive(tabId, event)), {
    tabId: raceTab,
    events: [
      { kind: "turn_started", turnId: newTurn, seq: 1, status: "in_progress", runtimeEpoch: newEpoch },
      { kind: "text", text: "新会话继续内容", seq: 2, turnId: newTurn, status: "in_progress", runtimeEpoch: newEpoch },
      { kind: "tool_dispatch", tool: { id: "current-generation-tool", name: "read_file", args: "new", readOnly: true }, seq: 3, turnId: newTurn, status: "in_progress", runtimeEpoch: newEpoch },
    ],
  });
  assert.ok(newGenerationAccepted.every(Boolean), "new-generation events start from their own sequence space");
  await page.evaluate(({ tabId, page }) => window.reasonixReplayProbe.releaseReplay(tabId, page), {
    tabId: raceTab,
    page: {
      events: [
        { turnId: oldTurn, seq: 3, status: "in_progress", runtimeEpoch: oldEpoch, event: { kind: "notice", level: "info", text: "旧代次迟到提示" } },
        { turnId: oldTurn, seq: 4, status: "in_progress", runtimeEpoch: oldEpoch, event: { kind: "tool_dispatch", tool: { id: "stale-generation-tool", name: "bash", args: "old", readOnly: false } } },
      ],
      floorSeq: 1, latestSeq: 4, nextAfterSeq: 4, hasMore: false, resetRequired: false, runtimeEpoch: oldEpoch,
    },
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 25)));
  const afterGenerationRace = await page.evaluate((tabId) => window.reasonixReplayProbe.snapshot(tabId), raceTab);
  assert.equal(afterGenerationRace.kinds.notice ?? 0, 0, "a delayed old-generation replay cannot append its notice to the new session");
  assert.equal(afterGenerationRace.tools.some((tool) => tool.id === "stale-generation-tool"), false,
    "a delayed old-generation replay cannot append its tool card to the new session");
  assert.equal(afterGenerationRace.tools.find((tool) => tool.id === "current-generation-tool")?.status, "running",
    "the new session keeps its own live tool card after the stale replay resolves");
  assert.equal(afterGenerationRace.uniqueItemIds, afterGenerationRace.itemCount,
    "the generation switch leaves all restored and live rows uniquely identified");
  process.stdout.write("  PASS  delayed replay from an old session generation cannot write into the new session\n");
} finally {
  await browser?.close();
  await server.close();
}
