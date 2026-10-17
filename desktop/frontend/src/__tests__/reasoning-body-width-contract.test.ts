// Run: tsx src/__tests__/reasoning-body-width-contract.test.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(testDir, "../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let passed = 0;
let failed = 0;

function ok(value: unknown, label: string) {
  if (value) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`);
    failed += 1;
  }
}

type Rule = { selector: string; body: string };

const rules: Rule[] = [];
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  for (const selector of match[1].split(",")) {
    rules.push({ selector: selector.trim(), body: match[2] });
  }
}

function declarations(selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selector !== selector) continue;
    for (const declaration of rule.body.split(";")) {
      const index = declaration.indexOf(":");
      if (index < 0) continue;
      merged.set(declaration.slice(0, index).trim(), declaration.slice(index + 1).trim());
    }
  }
  return merged;
}

console.log("\nreasoning body width contract");

// The expanded body shares one rule for both the inline transcript fold and the
// message reasoning panel. Stretching only the body keeps the compact heading
// at its content width while the content fills the message region.
for (const selector of [".reasoning__body", ".turn-collapse__inline-reasoning"]) {
  const decls = declarations(selector);
  eq(decls.get("align-self"), "stretch", `${selector} stretches to the message region width`);
  ok(!decls.has("width"), `${selector} does not pin a hard-coded width`);
  ok(!decls.has("align-items"), `${selector} leaves cross-axis alignment to the host`);
  eq(decls.get("box-sizing"), undefined, `${selector} relies on the global border-box reset`);
}

// The flex column host must keep `align-items: flex-start`; changing it to
// stretch would enlarge the heading's click target.
const phase = declarations(".turn-collapse__reasoning-phase");
eq(phase.get("display"), "flex", "reasoning phase host stays a flex column");
eq(phase.get("flex-direction"), "column", "reasoning phase host keeps its column axis");
eq(phase.get("align-items"), "flex-start", "reasoning phase host keeps compact children");

// Both headings stay inline-flex so their hit area tracks their label, not the
// transcript width.
eq(declarations(".turn-collapse__reasoning-head").get("display"), "inline-flex", "inline reasoning heading stays inline-flex");
eq(declarations(".reasoning__head").get("display"), "inline-flex", "panel reasoning heading stays inline-flex");

// No reasoning width rule may reintroduce a fixed pixel body or heading size.
const hardCoded = rules.filter(
  (rule) =>
    /\.(reasoning__body|turn-collapse__inline-reasoning|turn-collapse__reasoning-phase|reasoning__head|turn-collapse__reasoning-head)\b/.test(rule.selector) &&
    /(?:^|;)\s*width\s*:\s*\d+(?:\.\d+)?px/.test(rule.body),
);
eq(hardCoded.map((rule) => rule.selector).join(", "), "", "no reasoning layout rule hard-codes a pixel width");

// The body owns horizontal chrome (left margin + border-left + padding-left) and
// must be border-box so stretching cannot overflow the host.
const body = declarations(".reasoning__body");
ok(
  /^8px$/.test(body.get("margin") ?? "") || /^2px 0(?:px)? 6px 8px$/.test(body.get("margin") ?? ""),
  `expanded reasoning keeps its fixed left inset (margin: ${body.get("margin")})`,
);
eq(body.get("padding-left"), "12px", "expanded reasoning keeps its body padding");
ok(/^2px\b/.test(body.get("border-left") ?? ""), "expanded reasoning keeps its 2px guide border");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
