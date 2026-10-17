import { getDefaultCollapsed, setDefaultCollapsed, toggleDefaultCollapsed } from "../lib/defaultCollapsedPreference";
import { getReasoningExpansionPolicy, setReasoningExpansionPolicy } from "../lib/reasoningExpansionPolicy";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string) {
  if (cond) { process.stdout.write(`  PASS  ${label}\n`); passed += 1; }
  else { process.stdout.write(`  FAIL  ${label}\n`); failed += 1; }
}

console.log("\ndefault collapsed shim");

setReasoningExpansionPolicy("all-expanded");
ok(getDefaultCollapsed() === false, "all-expanded maps to defaultCollapsed=false");
ok(setDefaultCollapsed(true) === undefined, "setDefaultCollapsed returns void");
ok(getReasoningExpansionPolicy() === "all-collapsed", "boolean true writes all-collapsed");
ok(getDefaultCollapsed() === true, "all-collapsed maps to defaultCollapsed=true");
setDefaultCollapsed(false);
ok(getReasoningExpansionPolicy() === "all-expanded", "boolean false writes all-expanded");
ok(toggleDefaultCollapsed() === true, "toggle returns the new value");
ok(getDefaultCollapsed() === true, "toggle flips the boolean");
toggleDefaultCollapsed();
ok(getReasoningExpansionPolicy() === "all-expanded", "toggle round-trips back");

// The shim must not invent a third state: writing a boolean never lands on
// latest-only, so legacy callers cannot pin the newest-only behavior.
setReasoningExpansionPolicy("latest-only");
ok(getDefaultCollapsed() === false, "latest-only reads as not-collapsed (older callers see the old default)");
setDefaultCollapsed(true);
ok(getReasoningExpansionPolicy() === "all-collapsed", "writing a boolean over latest-only is explicit and allowed");
setDefaultCollapsed(false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
