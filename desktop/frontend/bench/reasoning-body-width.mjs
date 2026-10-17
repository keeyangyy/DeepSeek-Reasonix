import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Real-DOM layout regression for expanded reasoning bodies. A flex column host
// with `align-items: flex-start` sizes children at their intrinsic width, so a
// short reasoning body used to render in a narrow box while a long one filled
// the row. The body must always own the message region's available width while
// the compact heading keeps its content width.
const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = !process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === ".pw-browsers"
  ? path.join(frontendDir, ".pw-browsers")
  : process.env.PLAYWRIGHT_BROWSERS_PATH;

const VIEWPORTS = [{ width: 1600, height: 1000 }, { width: 1120, height: 900 }, { width: 780, height: 900 }];
const LAYOUTS = ["creation", "workbench"];
const CASES = ["short", "long", "markdown", "code", "streaming", "history", "panel-short", "panel-markdown"];
// Heading text and icons stay content-sized; only a compact chrome change would
// move these. Asserting a ceiling (not an exact value) keeps the check about
// "not stretched" rather than about font metrics.
const HEADING_MAX_WIDTH = 220;

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

async function measure(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    return [...document.querySelectorAll("[data-case]")].map((root) => {
      const hostCandidate = root.querySelector(".turn-collapse__reasoning-phase");
      const host = hostCandidate ?? root.querySelector(".reasoning");
      const body = root.querySelector(".reasoning__body");
      const heading = root.querySelector(".turn-collapse__reasoning-head, .reasoning__head");
      const hostRect = host?.getBoundingClientRect();
      const bodyRect = body?.getBoundingClientRect();
      return {
        id: root.getAttribute("data-case"),
        variant: root.getAttribute("data-variant"),
        hasBody: Boolean(body),
        hostWidth: round(hostRect?.width ?? 0),
        headingWidth: round(heading?.getBoundingClientRect().width ?? 0),
        bodyWidth: round(bodyRect?.width ?? 0),
        bodyLeftInset: round((bodyRect?.left ?? 0) - (hostRect?.left ?? 0)),
        bodyRightGap: round((hostRect?.right ?? 0) - (bodyRect?.right ?? 0)),
        bodyOverflowX: body ? body.scrollWidth - body.clientWidth : 0,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  });
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

  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/bench/reasoning-body-width.html`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    const rows = await measure(page);
    assert.deepEqual(pageErrors, [], "the reasoning probe renders without page errors");
    assert.equal(rows.length, LAYOUTS.length * CASES.length, "every layout/case pair renders");

    for (const layout of LAYOUTS) {
      const layoutRows = rows.filter((row) => row.id.startsWith(`${layout}-`));
      const bodies = layoutRows.filter((row) => row.hasBody);
      assert.equal(bodies.length, CASES.length, `${layout}: every case mounts an expanded reasoning body`);

      for (const row of layoutRows) {
        // Border-box plus a fixed left inset (margin 8 + border 2 + padding 12)
        // must fill the host without pushing past its right edge.
        assert.ok(Math.abs(row.bodyRightGap) <= 1, `${row.id} @${viewport.width}: body reaches the host's right edge (gap ${row.bodyRightGap}px)`);
        assert.ok(row.bodyLeftInset >= 0 && row.bodyLeftInset <= 10, `${row.id} @${viewport.width}: body keeps its compact left inset (${row.bodyLeftInset}px)`);
        assert.ok(row.bodyWidth > 0, `${row.id} @${viewport.width}: body has width`);
        assert.ok(row.bodyOverflowX <= 1, `${row.id} @${viewport.width}: body does not overflow horizontally (${row.bodyOverflowX}px)`);
        assert.ok(row.headingWidth <= HEADING_MAX_WIDTH, `${row.id} @${viewport.width}: heading stays content-sized (${row.headingWidth}px)`);
      }

      // Widths are uniform across content shapes: short text, long prose,
      // Markdown, code fences, streaming text, and replayed history. The inline
      // fold and the message panel mount in different containers (the fold body
      // carries its own 14px inset), so each path is checked against its host.
      for (const variant of ["inline", "panel"]) {
        const variantRows = layoutRows.filter((row) => row.variant === variant);
        assert.ok(variantRows.length > 0, `${layout}/${variant}: renders cases`);
        const widths = variantRows.map((row) => row.bodyWidth);
        const spread = Math.max(...widths) - Math.min(...widths);
        assert.ok(spread <= 1, `${layout}/${variant} @${viewport.width}: every reasoning case uses the same body width (spread ${spread}px)`);
      }
    }

    const documentOverflow = rows[0]?.documentOverflowX ?? 0;
    // The probe page itself is fixed-width content; only the reasoning bodies
    // are under test here, so require them not to add overflow of their own.
    assert.ok(documentOverflow <= 1, `reasoning bodies add no horizontal overflow at ${viewport.width}px (${documentOverflow}px)`);
    pass(`expanded reasoning fills the message region at ${viewport.width}px (${rows.length} layout/case pairs)`);
    const shot = process.env.REASONIX_REASONING_WIDTH_SHOT;
    if (shot && viewport === VIEWPORTS[0]) {
      // Opt-in only: CI never writes artifacts into the checkout.
      await page.screenshot({ path: path.resolve(shot), fullPage: true });
    }
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
