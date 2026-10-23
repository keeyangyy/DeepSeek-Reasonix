import { completionSummaryChangeNotice } from "../lib/completionSummary";
import type { DictKey, Translator } from "../lib/i18n";

const messages: Partial<Record<DictKey, string>> = {
  "notice.completionChangesTitle": "Changes this turn",
  "notice.completionChangesBody": "{count} changes",
  "notice.completionChangesFiles": "{count} files",
};

const translate: Translator = (key, vars) => {
  const value = messages[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
};

const base = {
  preset: "balanced",
  verdict: "complete",
  mutations: 3,
  checks_passed: 0,
  checks_failed: 0,
  checks_suppressed: 0,
  review: "passed",
  constraint_degraded: false,
};

const notice = completionSummaryChangeNotice(base, translate);

if (notice.body !== "3 changes" || notice.body.includes("file")) {
  throw new Error(`mutation receipt notice = ${notice.body}, want receipt-neutral changes wording`);
}

// The host counts distinct delivery-mutation paths and sends them as
// changed_files; the card must surface that count next to the receipt count,
// otherwise the UI has no file number even though the backend computed one.
const withFiles = completionSummaryChangeNotice({ ...base, changed_files: 2 }, translate);
if (withFiles.body !== "3 changes · 2 files") {
  throw new Error(`notice with changed_files = ${withFiles.body}, want the file count appended`);
}

// A turn that mutated nothing still reports no file clause rather than "0 files".
const zeroFiles = completionSummaryChangeNotice({ ...base, changed_files: 0 }, translate);
if (zeroFiles.body !== "3 changes") {
  throw new Error(`notice with changed_files=0 = ${zeroFiles.body}, want no file clause`);
}

// Older hosts omit the field entirely; the card must stay receipt-only.
const missing = completionSummaryChangeNotice({ ...base, changed_files: undefined }, translate);
if (missing.body !== "3 changes") {
  throw new Error(`notice without changed_files = ${missing.body}, want no file clause`);
}
