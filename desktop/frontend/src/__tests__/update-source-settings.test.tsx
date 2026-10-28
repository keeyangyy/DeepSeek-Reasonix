// 更新源设置：URL 校验、默认列表、折叠/展开与官方源的固定位置。
//
// Run: node --import ./scripts/css-stub-register.mjs --import tsx src/__tests__/update-source-settings.test.tsx

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../lib/i18n";
import { BUILTIN_MIRRORS, defaultUpdateSource, normalizeMirrorURL } from "../lib/updateSource";
import { UpdateSourceSettings } from "../components/UpdateSourceSettings";

let passed = 0;
let failed = 0;

function ok(value: boolean, label: string) {
  process.stdout.write(`  ${value ? "PASS" : "FAIL"}  ${label}\n`);
  if (value) passed += 1;
  else failed += 1;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

process.stdout.write("\n更新源：URL 校验\n");

{
  ok(normalizeMirrorURL("https://gh-proxy.com") === "https://gh-proxy.com", "https 地址直接接受");
  ok(normalizeMirrorURL("https://gh-proxy.com/") === "https://gh-proxy.com", "去掉尾部斜杠");
  ok(normalizeMirrorURL("  https://gh-proxy.com//  ") === "https://gh-proxy.com", "去空白与多余斜杠");
  ok(normalizeMirrorURL("http://gh-proxy.com") === "", "拒绝明文 http");
  ok(normalizeMirrorURL("gh-proxy.com") === "", "拒绝缺少 scheme");
  ok(normalizeMirrorURL("") === "", "拒绝空串");
}

process.stdout.write("\n更新源：默认配置\n");

{
  const cfg = defaultUpdateSource();
  ok(cfg.enabled === true, "默认开启镜像加速");
  ok(cfg.mirrors.length === BUILTIN_MIRRORS.length, "内置镜像全部在列");
  ok(cfg.mirrors.every((m) => m.enabled), "每一行默认启用");
  ok(cfg.mirrors.every((m) => m.url.startsWith("https://")), "内置镜像都是 https");
}

process.stdout.write("\n更新源：组件渲染\n");

{
  const dom = installDom();
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);

  await act(async () => {
    root.render(
      <LocaleProvider>
        <UpdateSourceSettings />
      </LocaleProvider>,
    );
  });
  // 等 hook 的异步读取落定
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  const text = () => rootEl.textContent ?? "";
  const switches = () => rootEl.querySelectorAll('[role="switch"]');
  // LocaleProvider follows the host locale, which is en-US under jsdom, so the
  // assertions accept either language instead of pinning one.
  const hasAny = (needles: string[]) => needles.some((n) => text().includes(n));

  ok(hasAny(["使用镜像加速下载", "Use mirrors"]), "折叠行显示总开关文案");
  ok(switches().length === 1, "折叠时只有总开关一个 switch");
  ok(!hasAny(["官方直连（GitHub）", "Official (GitHub)"]), "折叠时列表不展开");

  const head = rootEl.querySelector('[role="button"][tabindex="0"]') as HTMLElement | null;
  await act(async () => { head?.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  ok(hasAny(["官方直连（GitHub）", "Official (GitHub)"]), "展开后出现官方直连行");
  ok(hasAny(["全部失败时回退", "Fallback when all mirrors fail"]), "官方源前有回退分隔说明");

  const rows = Array.from(rootEl.querySelectorAll("div")).filter((el) =>
    hasAny(["官方直连（GitHub）", "Official (GitHub)"]) && (el.textContent ?? "").includes("Official (GitHub)") ||
    (el.textContent ?? "").includes("官方直连（GitHub）"),
  );
  const officialRow = rows[rows.length - 1];
  ok(
    !!officialRow && (officialRow.textContent ?? "").match(/固定最后|Fixed last/) !== null,
    "官方源标注固定最后",
  );

  // 官方行必须是列表中最后一个镜像行：它前面不能再有别的源。
  const allText = text();
  const officialAt = Math.max(allText.indexOf("官方直连（GitHub）"), allText.indexOf("Official (GitHub)"));
  const firstMirrorAt = Math.max(allText.indexOf("gh-proxy.com"), allText.indexOf("ghfast.top"));
  ok(officialAt > firstMirrorAt && firstMirrorAt >= 0, "官方源排在镜像之后");

  await act(async () => { root.unmount(); });
  dom.window.close();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
