import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = !process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === ".pw-browsers"
  ? path.join(frontendDir, ".pw-browsers")
  : process.env.PLAYWRIGHT_BROWSERS_PATH;
const server = await createServer({
  root: frontendDir,
  configFile: path.join(frontendDir, "vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;

function pass(label) {
  process.stdout.write(`  PASS  ${label}\n`);
}

try {
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
  const page = await browser.newPage({ viewport: { width: 1320, height: 800 } });
  await page.addInitScript(() => {
    window.reasonixLayoutTextRects = (element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const rects = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        rects.push(...range.getClientRects());
      }
      return rects.filter((rect) => rect.width > 0 && rect.height > 0);
    };
  });
  await page.route("**/MarkdownRenderer.tsx*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${address.port}/bench/transcript-live-layout.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.reasonixLayoutProbe.update("现在", true));
  await page.waitForSelector(".msg--assistant .msg__body .md--stream-tail");
  const initial = await page.locator(".msg--assistant .msg__body").evaluate((body) => {
    const rects = window.reasonixLayoutTextRects(body);
    const bodyTop = body.getBoundingClientRect().top;
    return {
      text: body.textContent,
      lineOffset: rects[0] ? rects[0].top - bodyTop : Number.POSITIVE_INFINITY,
      pendingFallbacks: body.querySelectorAll("[data-transcript-geometry-pending]").length,
    };
  });
  assert.equal(initial.text, "现在");
  assert.equal(initial.pendingFallbacks, 0, "an empty committed prefix does not reserve a blank line above the live tail");
  assert.ok(initial.lineOffset < 8, `first live text starts in the first line (offset ${initial.lineOffset}px)`);
  pass("first live CJK characters render on the first line without a delayed jump");

  const sentence = "现在加一个「输出名生成 + 重算兼容性」的辅助函数，这样改名后判定会跟着更新。";
  await page.evaluate((text) => window.reasonixLayoutProbe.update(text, true), sentence);
  const live = await page.locator(".msg--assistant .msg__body").evaluate((body) => {
    const rects = window.reasonixLayoutTextRects(body);
    return { text: body.textContent, lines: rects.length, top: rects[0]?.top };
  });
  assert.equal(live.text, sentence);
  assert.equal(live.lines, 1, "continuous no-newline prose stays on one line when it fits the available width");
  pass("live no-newline prose remains continuous at a fixed width");

  await page.evaluate((text) => window.reasonixLayoutProbe.update(text, false), sentence);
  await page.waitForFunction(() => !document.querySelector(".msg--assistant .msg__body .md--stream-tail"));
  const settled = await page.locator(".msg--assistant .msg__body").evaluate((body) => {
    const rects = window.reasonixLayoutTextRects(body);
    return { text: body.textContent, lines: rects.length, top: rects[0]?.top };
  });
  assert.equal(settled.text, sentence);
  assert.equal(settled.lines, 1);
  assert.ok(Math.abs((settled.top ?? 0) - (live.top ?? 0)) < 8, "stream completion does not move the sentence to a different line");
  pass("stream completion preserves the sentence line and position");

  const readTreeRow = (root) =>
    root.evaluate((row) => {
      const label = row.querySelector(".project-tree__topic-label");
      const actions = row.querySelector(".project-tree__topic-actions");
      const side = row.querySelector(".project-tree__topic-side");
      const time = row.querySelector(".project-tree__topic-time");
      const main = row.querySelector(".project-tree__topic-main");
      const buttons = [...row.querySelectorAll(".project-tree__topic-action")];
      return {
        labelRight: label?.getBoundingClientRect().right ?? 0,
        actionsLeft: actions?.getBoundingClientRect().left ?? 0,
        actionsWidth: actions ? actions.getBoundingClientRect().width : 0,
        sideWidth: side ? side.getBoundingClientRect().width : 0,
        timeWidth: time ? time.getBoundingClientRect().width : 0,
        actionGap: actions ? getComputedStyle(actions).gap : "",
        buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
        reservedSpace: main ? getComputedStyle(main).paddingRight : "",
      };
    });

  // The fixture carries --menu-open so the buttons are revealed without a
  // pointer. In that state the timestamp column releases its slot, which is what
  // lets the label keep its width budget instead of being overdrawn.
  const revealed = await readTreeRow(page.locator(".project-tree__topic--has-actions"));
  assert.ok(revealed.labelRight <= revealed.actionsLeft, "topic text is clipped before the action buttons begin");
  assert.deepEqual(revealed.buttonWidths, [22, 22, 22]);
  assert.equal(revealed.actionGap, "2px");
  assert.equal(revealed.actionsWidth, 70, "the three buttons occupy their own 70px slot");
  assert.equal(revealed.sideWidth, 0, "the timestamp releases its slot while the buttons are shown");
  assert.equal(revealed.reservedSpace, "0px");

  // Idle: the same row with the reveal modifier removed. The timestamp keeps its
  // slot but hugs the time label instead of reserving a fixed 58px band — that
  // fixed band was what pushed the time ~30px away from the title.
  await page.evaluate(() => {
    document.querySelector(".project-tree__topic--has-actions")?.classList.remove("project-tree__topic--menu-open");
  });
  const idle = await readTreeRow(page.locator(".project-tree__topic--has-actions"));
  assert.ok(idle.labelRight <= idle.actionsLeft, "idle topic text stays clear of the action slot");
  assert.ok(idle.sideWidth > 0, "the idle row keeps the timestamp slot");
  assert.ok(
    Math.abs(idle.sideWidth - idle.timeWidth) < 8,
    `the idle timestamp side hugs the time label (side ${idle.sideWidth}px vs time ${idle.timeWidth}px)`,
  );
  assert.equal(idle.reservedSpace, "12px");
  await page.evaluate(() => {
    document.querySelector(".project-tree__topic--has-actions")?.classList.add("project-tree__topic--menu-open");
  });
  pass("project topic labels stop before the compact three-button action group");

  const classicTree = await page.evaluate(() => {
    const workbench = document.querySelector(".sidebar--workbench");
    const classic = workbench.cloneNode(true);
    classic.className = "app--classic";
    classic.style.left = "380px";
    document.body.append(classic);
    const row = classic.querySelector(".project-tree__topic--has-actions");
    const label = row.querySelector(".project-tree__topic-label");
    const actions = row.querySelector(".project-tree__topic-actions");
    const main = row.querySelector(".project-tree__topic-main");
    const side = row.querySelector(".project-tree__topic-side");
    const time = row.querySelector(".project-tree__topic-time");
    const revealed = {
      labelRight: label.getBoundingClientRect().right,
      actionsLeft: actions.getBoundingClientRect().left,
      sideWidth: side.getBoundingClientRect().width,
      reservedSpace: getComputedStyle(main).paddingRight,
    };
    row.classList.remove("project-tree__topic--menu-open");
    const idle = {
      labelRight: label.getBoundingClientRect().right,
      sideWidth: side.getBoundingClientRect().width,
      timeWidth: time ? time.getBoundingClientRect().width : 0,
      reservedSpace: getComputedStyle(main).paddingRight,
    };
    classic.remove();
    return { revealed, idle };
  });
  assert.ok(classicTree.revealed.labelRight <= classicTree.revealed.actionsLeft, "classic topic text is clipped before the action buttons begin");
  assert.equal(classicTree.revealed.sideWidth, 0, "classic timestamp releases its slot while the buttons are shown");
  assert.ok(classicTree.idle.sideWidth > 0, "the classic idle row keeps the timestamp slot");
  assert.ok(
    Math.abs(classicTree.idle.sideWidth - classicTree.idle.timeWidth) < 8,
    `classic idle timestamp side hugs the time label (side ${classicTree.idle.sideWidth}px vs time ${classicTree.idle.timeWidth}px)`,
  );
  assert.equal(classicTree.idle.reservedSpace, "9px");
  pass("classic project topic rows share the timestamp and action slot");
} finally {
  await browser?.close();
  await server.close();
}
