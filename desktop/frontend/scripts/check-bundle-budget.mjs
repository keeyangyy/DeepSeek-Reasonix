import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const distDir = resolve("dist");
const indexPath = resolve(distDir, "index.html");
const html = readFileSync(indexPath, "utf8");

function gzipBytes(path) {
  return gzipSync(readFileSync(path), { level: 9 }).byteLength;
}

function initialAssetPaths(extension) {
  const pattern = extension === ".js"
    ? /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+\.js)["'][^>]*>/g
    : /<link\b[^>]+href=["']([^"']+\.css)["'][^>]*>/g;
  return [...new Set([...html.matchAll(pattern)].map((match) => resolve(distDir, match[1])))];
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function assertBudget(label, actual, budget) {
  if (actual > budget) {
    throw new Error(`${label} is ${formatKiB(actual)}; budget is ${formatKiB(budget)}`);
  }
  process.stdout.write(`  PASS  ${label}: ${formatKiB(actual)} / ${formatKiB(budget)}\n`);
}

const initialJS = initialAssetPaths(".js");
const initialCSS = initialAssetPaths(".css");
if (!initialJS.length) throw new Error("no initial JavaScript assets found in dist/index.html");
// initial CSS 允许为空：styles.css 走 ?url 延迟加载，feature 样式走 lazy chunk。

// main.tsx intentionally loads styles.css before mounting React so the inline
// boot shell can paint without waiting for the full application stylesheet.
// Vite emits that entry as styles-<hash>.css; keep it in the startup budget
// while also proving it never drifts back into the render-blocking HTML path.
const appShellCSS = readdirSync(resolve(distDir, "assets"))
  .filter((name) => /^styles-.+\.css$/.test(name))
  .map((name) => resolve(distDir, "assets", name));
if (appShellCSS.length !== 1) {
  throw new Error(`expected exactly one deferred app-shell stylesheet, found ${appShellCSS.length}`);
}
if (initialCSS.some((path) => appShellCSS.includes(path))) {
  throw new Error("app-shell stylesheet must not block the inline boot shell's first paint");
}

const initialJSGzip = initialJS.reduce((total, path) => total + gzipBytes(path), 0);
const initialCSSGzip = initialCSS.reduce((total, path) => total + gzipBytes(path), 0);
const appShellCSSGzip = appShellCSS.reduce((total, path) => total + gzipBytes(path), 0);
const largestInitialJS = Math.max(...initialJS.map(gzipBytes));
const largestInitialJSRaw = Math.max(...initialJS.map((path) => statSync(path).size));
const localeChunks = readdirSync(resolve(distDir, "assets"))
  .filter((name) => /^(?:zh|zh-TW)-.+\.js$/.test(name))
  .map((name) => resolve(distDir, "assets", name));

console.log("\nbundle budgets");
// React Virtuoso replaces the transcript's custom measurement/anchor engine.
// Its production runtime adds 16.9 KiB gzip (4.2%) over the 402 KiB baseline.
// This exceptional overrun is locally attributable and trades ~1400 lines of
// competing state machines for a maintained library. Native-tail finish helpers
// then sat on the 423.5 KiB gate (Windows CI: 423.5 / 423.5); this 0.5 KiB
// raise (0.12%) absorbs that leave-cancel / remasure-once code without
// widening the original Virtuoso exception. The project-tree archive race
// guards add 611 bytes gzip over main-v2's 423.988 KiB startup path after the
// blank-project flow landed; project-topic sort invalidation and request
// ordering add another bounded 0.2 KiB. Retain both owner boundaries with a
// narrowly rounded 1 KiB ratchet.
// Diagnostic builds intentionally keep content-free row geometry and scroll
// transition probes in the initial transcript path. Stable builds retain the
// existing production ratchet. Per-row measurement versions and a bounded
// recovery probe add less than 0.1% gzip; retain them with a 0.5 KiB (0.118%)
// production ratchet rather than weakening either recovery contract. The
// bounded allowance also covers small gzip drift from the embedded build SHA.
// Reader extent stabilization adds 1.2 KiB gzip (0.28%) in production for its
// bounded input, collapse, rebound, and ownership transaction. Retain it with
// a 1.5 KiB (0.35%) ratchet instead of weakening the Windows scroll invariant.
// Complete-history navigation adds 0.3 KiB gzip (0.070%) to that production
// path while keeping its 1.68 KiB question rail lazy-loaded. Test diagnostics
// plus the navigation owner add 0.7 KiB gzip (0.164%) over the merged test gate.
// DingTalk channel status and locale wiring move the current-base production
// build from 427.2 to 427.7 KiB and test from 428.6 to 429.1 KiB. The unified
// state-aware geometry contract, session diagnostics counters, and guarded
// native-scroll probes add 2.4 KiB gzip to the initial path. The current
// main-v2 merge adds another 0.3 KiB of deterministic shared startup code.
// Keep the increase explicit and bounded instead of hiding it in a broad
// percentage ratchet.
// The retained-transcript surface adds a small, bounded navigation owner to
// the startup path (overlay state + stale-completion guard). Keep the increase
// explicit and narrow; the measured build is 431.1 KiB gzip.
// The web-search tool card now resolves the same display projection lazily so
// its filtered count matches the assistant Sources panel. The measured build
// is 431.509 KiB gzip; keep 0.1 KiB of explicit headroom for hash/toolchain
// drift instead of relying on a rounded equality.
// Remote onboarding [0.5/3] adds project-group and credential-chain wiring on
// top of the lazy wizard. Exact-turn routing, the extracted event-gap
// projector, checkpoint resets, and the navigation surface transaction bring
// the current main-v2 path to 437.36 KiB gzip.
// The full remote-session surface adds the lazy transcript bridge and tab
// lifecycle on top of [0.5/3]. Keep the measured stack's narrow ratchet.
// Remote approval hardening adds authoritative composer-profile hydration,
// scoped rewind dispatch, and attachment/inbox fences to the always-mounted
// remote hook. The measured production path is 438.38 KiB gzip after keeping
// the integration modules below repolint's ownership ceilings; retain 0.12 KiB
// toolchain headroom with a bounded 1.4 KiB ratchet.
// Remote status isolation keeps the always-mounted status bar on the active
// remote transcript and routes job cancellation to that host. Parsers and
// retry policy remain lazy; the measured selector adds under 0.1 KiB gzip.
// Remote runtime parity adds scoped approvals, status-only reconciliation,
// session quality-floor routing, dropped-frame reconciliation, and remote
// runtime-command dispatch. The measured initial path is 439.60 KiB;
// retain 0.10 KiB of bounded toolchain headroom.
// Closing the remaining review gaps adds generation-fenced hydration plus
// remote-only tool payload, Todo, and terminal isolation. The measured path is
// 439.74 KiB; retain 0.06 KiB of headroom with a 0.1 KiB ratchet.
// The final remote-runtime parity pass adds remote run-strip telemetry,
// explicit session verbs, and specialized plan decisions. The measured path
// is 440.02 KiB. The current main-v2 turn-event, finish-protocol, and session
// repair runtime then moves the combined path to 445.097 KiB; retain 0.103 KiB
// of bounded build/toolchain headroom.
// Atomic remote profile changes, exact approval draining, and generation-safe
// history handoff bring the measured path to 445.228 KiB. Retain 0.072 KiB of
// headroom with the smallest existing decimal ratchet.
// Direct pending-prompt recovery and authoritative remote Goal state bring the
// measured path to 445.473 KiB. Retain 0.027 KiB of bounded headroom.
// Restored remote shells now activate their backend session immediately and
// keep disconnected state out of the mounted surface. The merged production
// path measures 445.614 KiB; retain 0.086 KiB of bounded build/toolchain
// headroom with the smallest existing decimal ratchet.
// Runtime-aware Todo presentation plus exact-tab continuation adds 0.3 KiB gzip
// to the always-mounted footer path. Keep the state/routing guard with a narrow
// ratchet rather than showing idle restored work as actively running. The
// combined path measures 445.9 KiB; retain 0.1 KiB of toolchain headroom.
// Transcript surface ownership and the token-fenced unloaded-question commit
// move the exact main-v2 baseline from 445.865 to 447.587 KiB gzip (+0.39%).
// The final 0.266 KiB retains jump ownership through paint-ready instead of
// allowing a native scrollend to release it. Keep only 0.213 KiB headroom;
// native validation hosts and test fixtures stay outside the production graph.
// Cross-platform shell inventory, current-session vs after-reload rows,
// manual repair guidance, and exact download-host allowlisting move the merged
// path from 448.692 to 449.758 KiB (+1.066 KiB). Retain 0.142 KiB of bounded
// build/toolchain headroom.
// The reader transaction contract (geometry revisions, generation-fenced
// writer requests, gesture travel proof, stabilized-shrink extent acceptance,
// and the blank-rebound prepaint lane) adds a measured 3.978 KiB gzip on the
// merged main-v2 baseline. MCP elicitation and the inline Apps lifecycle remain
// on that startup graph; the combined path measures 455.0 KiB. Retain 0.2 KiB
// of bounded build/toolchain headroom.
// Generic elicitation validation adds field-specific localized accessibility
// copy to the English startup dictionary. The interaction code and CSS remain
// lazy; the measured path is 455.437 KiB. Retain 0.163 KiB of headroom.
// Stream-failure visibility (#9560) adds the last-discard reason and one
// terminal-notice dedupe flag, while provider no_proxy copy now states the
// custom-proxy precedence. The merged path measures 455.9 KiB; retain 0.1 KiB
// of bounded build/toolchain headroom.
// Exhausted tail repair now releases ownership so jump-bottom remains usable
// after a stranded native WebView extent. The WebView2 reachable-tail clamp
// then absorbs a second post-quiet extent without an unbounded write loop.
// The combined path measures 456.316 KiB; retain 0.084 KiB with the smallest
// one-decimal ratchet.
// The generation-bound history-prepend lease adds stable-key reader anchoring,
// full mounted coverage, and one final arbiter-owned correction. The measured
// path is 457.406 KiB after extracting the lease owner to satisfy repolint.
// Latest-base transcript settle ownership measures 457.523 KiB with this UX.
// Isolated conversation forks and their extracted browser mock adapter bring
// the combined tree to 458.158 KiB; completion uncertainty adds a terminal
// outcome and notice without exposing evaluator audits to the frontend,
// measuring 458.287 KiB gzip.
// Transactional Ask resolution and authoritative rejected-submit recovery add
// 0.3 KiB gzip to the initial controller path. Retain the exact turn fence,
// bounded ListTabs retry, and stale-prompt guard.
// Session-catalog repair presentation stays in the lazy project-tree chunk;
// compact shared helpers keep the combined initial path within the same gate.
// Merge-Back adds identity-bound inspection, navigation, and retained-recovery
// orchestration on top. The merged stable build measures 461.338 KiB and the
// test channel measures 461.323 KiB. Deferring selection ownership until a
// real range exists (#9703/#9711) and adding the session takeover banners
// move the combined path to 462.2 KiB. Local spectator reclaim adds the
// desktop-vs-remote command branch. Sticky Context's session-scoped file chips
// bring the merged stable path to 462.587 KiB. Windows' embedded build metadata
// lands just above the rounded 462.6 KiB boundary; retain one cross-platform
// decimal step without widening any chunk or raw gate.
// Reading the applied item-list transform (instead of the remembered offset)
// keeps the reader/anchor visual guards from compounding under reduced-motion
// WebView2; the merged path measures 462.827 KiB. Retain one decimal step.
// Generation-bound native-thumb transactions and the rebased custom-scrollbar
// drag add 0.3 KiB gzip; the merged path measures 463.102 KiB.
// Absorbing content-preserving block-window prepends into the active reader
// transaction adds 0.2 KiB gzip on top; the merged path measures 463.292 KiB,
// 8 bytes under the next decimal. Retain one cross-platform decimal step.
// The subagent outcome envelope, partial-state card, and history hydration add
// 0.5 KiB gzip on the initial path. The model-capability resolver and its
// read-only provider badges add a measured 0.2 KiB including gzip/toolchain
// rounding. The integrated management shell, image capability controls, and
// upstream updater refresh measure 465.4 KiB gzip (base: 464.7 KiB).
// Keep the next decimal ceiling and leave feature editors lazy.
// Durable protocol recovery controls and search-source status add 1.2 KiB
// over the same-environment main-v2 build (465.4 -> 466.6 KiB gzip).
// Keep one decimal of cross-platform headroom for this measured shell change.
// Integrating main-v2 rich-link menus measures 466.905 KiB combined.
// The AskCard session-draft wiring adds a bounded 30-byte gzip drift on the
// initial route. The session-runtime ordering fence adds 56 bytes and
// cross-platform zlib rounding reaches the same startup path; retain the
// explicit budget rather than failing on a rounded 467.0 KiB display value.
// The latest main-v2 session-runtime fence and exact prompt protocol measure
// 468.2 KiB here; retain a 0.1 KiB ceiling for platform zlib rounding.
// Mainline provider/settings integration measures 469.230 KiB gzip.
const initialJSBudgetKiB = 469.3;
assertBudget("initial JavaScript gzip", initialJSGzip, initialJSBudgetKiB * 1024);
assertBudget("largest initial JavaScript chunk gzip", largestInitialJS, 280 * 1024);
// Render-blocking CSS is intentionally absent: styles.css loads deferred via
// ?url, and feature styles (heartbeat) live in lazy chunks loaded on demand.
// An empty initial CSS list is the desired state, not a build error.
if (initialCSS.length > 0) {
  assertBudget("render-blocking CSS gzip", initialCSSGzip, 4 * 1024);
} else {
  process.stdout.write("  PASS  render-blocking CSS: none (all styles deferred)\n");
}
// Extension surfaces, Task Monitor, and compact decision receipts share the
// application stylesheet loaded before React mounts. Keep their combined
// allowance bounded even though the file is no longer render-blocking.
// Navigation overlay styles add a bounded 0.1 KiB to the deferred shell.
// The cleaned source panel adds 0.1 KiB gzip to the deferred shell on top of
// the retained-transcript navigation allowance; keep the ratchet explicit.
// The navigation mask's stable composer footprint and remote tab/surface
// states bring the merged shell to roughly 115.7 KiB gzip.
// The one-row model configuration list, responsive stacking, Automation's
// shared title-safe shell, and the shared harness decision surface measure
// 116.9 KiB gzip while reusing existing layout primitives. Retain a bounded
// 0.1 KiB headroom ratchet.
// Mainline provider/settings and recovery styles measure 119.435 KiB gzip.
assertBudget("deferred app-shell CSS gzip", appShellCSSGzip, 119.5 * 1024);
if (localeChunks.length !== 2) {
  throw new Error(`expected 2 on-demand Chinese locale chunks, found ${localeChunks.length}`);
}
for (const path of localeChunks) {
  const name = basename(path);
  // Task Monitor, billing, indexed history, Task Center, Extension UI, and
  // runtime controls plus execution-setting receipts add localized copy. The
  // write-access approval card adds four scoped actions and a home-risk
  // warning (~0.15 KiB gzip, +0.27% over the old 54.75 gate). Context
  // compaction settings add 40 bytes gzip of policy guidance to simplified
  // Chinese, while scheduled billing adds compact rate-band labels/tooltips.
  // The three StepFun presets add localized names/descriptions (~0.1 KiB
  // gzip); the two pay-as-you-go presets add the same again. The delivery
  // floor segmented control adds two labels plus one explanatory tooltip,
  // measured at 23 B gzip for zh and 8 B for zh-TW. Completion receipts add
  // six short status labels in each locale, requiring another 0.2 KiB per
  // language. DingTalk setup and mention guidance add at most 0.2 KiB more
  // (0.36%); retain the complete security and group-chat copy instead of
  // abbreviating user-facing instructions to fit the old locale ratchet.
  // Recovery-copy and catalog-only sidebar labels can move the simplified
  // Chinese chunk across the rounded 55.9 KiB boundary on CI's Node/zlib;
  // retain a narrow 0.1 KiB headroom rather than making gzip output a
  // platform-dependent gate. The OpenCode one-key setup adds product-level
  // connection, fallback, and legacy-state copy while removing protocol
  // choices from the primary UI; keep that complete guidance with a bounded
  // 0.4–0.5 KiB locale-only ratchet.
  // Git-Bash installation guidance adds localized copy across dialects.
  // MCP elicitation adds fourteen short labels per locale (~40 B gzip).
  // Generic schema validation adds complete field-error, privacy, and safe-
  // fallback copy. Measured chunks are 58.574 KiB zh and 59.368 KiB zh-TW;
  // retain roughly 0.13 KiB of platform headroom for each.
  // Stream-failure diagnostics add five strings per dialect. Together with the
  // reachable-tail recovery copy, the merged chunks measure 58.923 KiB zh and
  // 59.710 KiB zh-TW. The isolated-fork guidance brings the measured chunks
  // to 59.1 KiB zh and 59.9 KiB zh-TW; retain a narrow one-decimal ratchet.
  // Merge-Back lifecycle and recovery guidance measure 59.819 KiB zh and
  // 60.612 KiB zh-TW; retain only the next one-decimal ceiling for each.
  // The retained-recovery receipt and copy action move zh to 59.911 KiB;
  // session-catalog recovery guidance on the merged base moves zh-TW to
  // 60.757 KiB; retain only its exact one-decimal ceiling.
  // Session takeover adds ~20 locale keys per dialect (banners, dialog,
  // reclaim), while Sticky Context adds file-state and limit diagnostics. The
  // merged stable chunks measure 60.395 KiB zh and 61.232 KiB zh-TW; retain
  // only the next one-decimal ceiling for each dialect.
  // The outcome card adds one short localized status label per dialect. CI's
  // Windows zlib measured zh at 60.4 KiB exactly; capability-status copy adds
  // a small 0.1 KiB ratchet, so retain the next decimal ceiling rather than
  // dropping the unknown-state explanation.
  // Image input mode, provenance and unknown-state guidance measure 60.724 KiB
  // zh and 61.570 KiB zh-TW. Keep the next decimal ceiling per locale.
  // Protocol recovery and source-availability copy measure 60.927 KiB zh
  // and 61.789 KiB zh-TW (base: 60.8 / 61.6 rounded).
  // Rich-link action copy on the current base brings these to
  // 61.027/61.881 KiB; retain bounded cross-platform headroom.
  // Recovery retry copy reaches the rounded 61.1 KiB boundary on Node/zlib
  // toolchains; keep the next one-decimal ceiling for cross-platform CI.
  // The #9889/#9890 series adds recovery-wait, dialog-failure, and stall copy:
  // zh-TW measures 63492 B (62.004 KiB) with the four PRs merged together.
  // Integrated settings and ownership copy measures 61.415 / 62.212 KiB.
  // Session-log head versions (head kinds, current/covered wording, and the
  // three head notices) measure 61.7 / 62.4 KiB; keep the next one-decimal
  // ceiling for cross-platform CI.
  // Search assignment copy adds 239 / 231 B over main-v2 (63147 / 63920 B).
  // Measured result: 63386 / 64151 B; retain bounded cross-platform headroom.
  // The process-fold policy adds six short labels per dialect (the folding-mode
  // switch and its hints); the measured chunks move to 62.2 KiB zh and
  // 62.9 KiB zh-TW, so retain the next one-decimal ceiling for each dialect.
  // The trash turns filter adds four short labels per dialect; the bulk-action
  // bar adds seven more (select-all/clear, {n}-selected count, restore/delete
  // selected, row aria). zh measures 63827 B (62.331 KiB) and zh-TW 64622 B
  // (63.107 KiB); retain the next one-decimal ceiling for each dialect.
  // The sub-agent status strip adds two labels per dialect (running count,
  // overflow count) plus the fold header's sub-agent count; the measured chunks
  // move just past the previous ceiling, so retain the next one-decimal one.
  // The folded-work index setting adds three labels per dialect (the switch
  // and its hints); measured chunks move past the prior ceilings again.
  // The reasoning-expansion tier labels, the reasoning-language off option and
  // the update-panel status strings add the next tier: measured zh 64206 B
  // (62.702 KiB) and zh-TW 65019 B (63.495 KiB). Keep the next one-decimal
  // ceiling per dialect; zh only moved by 3 B, so its ratchet is rounding.
  const budget = name.startsWith("zh-TW-") ? 63.6 * 1024 : 62.8 * 1024;
  assertBudget(`${name} gzip`, gzipBytes(path), budget);
}

const rawInitialBytes = [...initialJS, ...initialCSS, ...appShellCSS]
  .reduce((total, path) => total + statSync(path).size, 0);
// Baseline 2444.0 KiB measured 2026-10-27 (app-shell styles 856 KiB + initial
// JS 1588 KiB). Keep 16 KiB (0.65%) of headroom so ordinary feature work does
// not have to shave bytes to fit; the gzip and chunk gates above stay tight and
// are the primary size guard.
//
// This gate catches unintentional startup bloat, it is not a per-feature
// accounting ledger. Earlier revisions kept 0.1-0.7 KiB of headroom and grew
// ~176 lines of per-change records; that history lives in git. When this number
// moves, state the measured value and the reason in the commit message.
const rawInitialBudgetKiB = 2_460.0;
assertBudget("initial raw JavaScript and CSS", rawInitialBytes, rawInitialBudgetKiB * 1024);
assertBudget("largest initial JavaScript chunk raw", largestInitialJSRaw, 1_000 * 1024);
