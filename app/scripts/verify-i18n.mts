// Key parity across locales, and the guarantee the operator asked for: a custom error
// cannot ship with copy in one language and missing in another.
//
// ── WHAT IS ENFORCED, AND WHAT IS ONLY REPORTED ───────────────────────────────
//
// SHIPPED_LOCALES are offered to users, so they must be COMPLETE -- every UI key and
// every one of the ABI's custom errors. A gap fails the build.
//
// PLANNED_LOCALES have files and may be partial. Their coverage is reported, never
// enforced, because enforcing it would mean either shipping machine translation or
// blocking the build until a human finishes. Moving a locale from PLANNED to SHIPPED is
// the single switch that turns enforcement on -- which is the point: an incomplete locale
// cannot be shipped by accident, because shipping it IS the act that starts checking it.
//
// The English fallback is exactly why this must be mechanical. A missing Korean key
// renders English and looks fine, so nobody notices by eye.
//
// Run: npm run verify:i18n   (also invoked by the root build via gen-revert-copy.js)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/en.ts";
import { zhHans } from "../src/i18n/zh-Hans.ts";
import { ko } from "../src/i18n/ko.ts";
import { SHIPPED_LOCALES, PLANNED_LOCALES, ALL_LOCALES, type Locale } from "../src/i18n/locales.ts";

const CATALOGUES: Record<string, unknown> = { en, "zh-Hans": zhHans, ko };

/** Every dotted leaf path in an object. */
function paths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(p);
    else out.push(...paths(v, p));
  }
  return out;
}

function lookupPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], obj);
}

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const enPaths = paths(en);
const enSet = new Set(enPaths);

// ── the ABI's custom errors must all have English copy ──────────────────────────
const abiSrc = readFileSync(new URL("../src/abi/lfx1.ts", import.meta.url), "utf8");
const abi = JSON.parse(abiSrc.slice(abiSrc.indexOf("["), abiSrc.lastIndexOf("]") + 1)) as {
  type: string;
  name: string;
}[];
const abiErrors = abi
  .filter((x) => x.type === "error")
  .map((e) => e.name)
  .sort();

console.log(`── ABI custom errors: ${abiErrors.length} ──`);
{
  const missing = abiErrors.filter((n) => !enSet.has(`errors.${n}`));
  check(
    "every ABI custom error has English copy",
    missing.length === 0,
    missing.length ? `MISSING: ${missing.join(", ")}` : `all ${abiErrors.length} covered`
  );

  // Copy for an error that no longer exists is dead: harmless at runtime, but it hides
  // that a rename happened, and the next reader trusts it.
  const errKeys = enPaths.filter((p) => p.startsWith("errors.")).map((p) => p.slice(7));
  const stale = errKeys.filter(
    (n) => !abiErrors.includes(n) && !["unrecognised", "noReason"].includes(n)
  );
  check(
    "no copy for errors that are not in the ABI",
    stale.length === 0,
    stale.length ? `STALE: ${stale.join(", ")}` : "none"
  );
}

// ── shipped locales must be complete ────────────────────────────────────────────
console.log(`\n── shipped locales (${SHIPPED_LOCALES.join(", ")}) — ENFORCED ──`);
for (const loc of SHIPPED_LOCALES) {
  const has = new Set(paths(CATALOGUES[loc]));
  const missingUi = enPaths.filter((p) => !p.startsWith("errors.") && !has.has(p));
  const missingErrors = abiErrors.filter((n) => !has.has(`errors.${n}`));

  check(
    `${loc}: every UI key present`,
    missingUi.length === 0,
    missingUi.length
      ? `MISSING ${missingUi.length}: ${missingUi.slice(0, 5).join(", ")}…`
      : `${enPaths.length} keys`
  );
  check(
    `${loc}: every custom error has copy`,
    missingErrors.length === 0,
    missingErrors.length ? `MISSING: ${missingErrors.join(", ")}` : `all ${abiErrors.length}`
  );

  // A key here but not in English is unreachable -- t() is typed against English -- so it
  // is dead weight that reads as coverage.
  const extra = paths(CATALOGUES[loc]).filter((p) => !enSet.has(p));
  check(`${loc}: no keys absent from English`, extra.length === 0, extra.join(", ") || "none");
}

// ── planned locales: reported, not enforced ─────────────────────────────────────
console.log(`\n── planned locales (${PLANNED_LOCALES.join(", ")}) — reported only ──`);
for (const loc of PLANNED_LOCALES) {
  const has = new Set(paths(CATALOGUES[loc]));
  const done = enPaths.filter((p) => has.has(p)).length;
  const errDone = abiErrors.filter((n) => has.has(`errors.${n}`)).length;
  const pct = ((done / enPaths.length) * 100).toFixed(0);
  console.log(
    `  ---   ${loc}: ${done}/${enPaths.length} keys (${pct}%), errors ${errDone}/${abiErrors.length}` +
      `${done < enPaths.length ? "  — not shippable yet" : "  — COMPLETE, ready for SHIPPED_LOCALES"}`
  );

  // Shape errors ARE enforced even while a translation is in flight: a key that does not
  // exist in English is a typo, and typos should not accumulate.
  const extra = paths(CATALOGUES[loc]).filter((p) => !enSet.has(p));
  check(`${loc}: no keys absent from English`, extra.length === 0, extra.join(", ") || "none");
}

// ── layout: the longest string per key ──────────────────────────────────────────
//
// Chinese renders shorter than English and Korean usually longer, so sizing a control to
// its English label sizes it to neither the common case nor the worst one. This reports
// keys where a translated string is already longest; `?pseudo=long` renders that worst
// case in the browser, and `?pseudo=expand` simulates Korean expansion before any Korean
// exists.
console.log("\n── layout: keys where a non-English locale is longest ──");
{
  const longer: { key: string; loc: Locale; en: number; other: number }[] = [];
  for (const p of enPaths) {
    const enLen = String(lookupPath(en, p) ?? "").length;
    for (const loc of ALL_LOCALES) {
      if (loc === "en") continue;
      const v = lookupPath(CATALOGUES[loc], p);
      if (typeof v === "string" && v.length > enLen) {
        longer.push({ key: p, loc, en: enLen, other: v.length });
      }
    }
  }
  if (longer.length === 0) {
    console.log("  (none yet — the translated catalogues are still small)");
  } else {
    for (const l of longer.slice(0, 12)) {
      console.log(`  ${l.key.padEnd(34)} ${l.loc} ${l.other} chars vs en ${l.en}`);
    }
    if (longer.length > 12) console.log(`  …and ${longer.length - 12} more`);
  }
}

// ── hardcoded user-facing strings ───────────────────────────────────────────────
//
// "No hardcoded user-facing strings" cannot be enforced by types: a component can render
// a bare literal and TypeScript is perfectly happy. So this scans the rendering layer for
// JSX text nodes and user-facing props that are not going through t().
//
// Deliberately NARROW -- JSX text of two or more words containing a lowercase letter,
// plus title/placeholder/aria-label literals. Narrow enough that a hit is almost always
// real, which is what stops it being ignored. A broad scanner that cries wolf gets
// disabled, and a disabled check is worse than none.
//
// diagnostics/ is EXEMPT: an internal instrument for reading raw wallet state, never
// shown to users, and translating it would make it harder to paste into a bug report.
console.log("\n── hardcoded user-facing strings ──");
{
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e === "i18n" || e === "diagnostics" || e === "abi") continue;
        walk(p);
      } else if (p.endsWith(".tsx")) {
        files.push(p);
      }
    }
  };
  walk(root);

  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // Strip JSX comment blocks, then skip ordinary comment lines.
        const code = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
        if (/^\s*(\/\/|\*|\/\*)/.test(code)) return;

        const text = code.match(/>\s*([A-Za-z][^<>{}\n]{6,})\s*</);
        if (text && /\s/.test(text[1].trim()) && /[a-z]/.test(text[1])) {
          hits.push(`${relative(root, f)}:${i + 1}  ${text[1].trim().slice(0, 60)}`);
          return;
        }
        const prop = code.match(/(title|placeholder|aria-label)="([^"]{6,})"/);
        if (prop && /\s/.test(prop[2])) {
          hits.push(`${relative(root, f)}:${i + 1}  ${prop[1]}="${prop[2].slice(0, 50)}"`);
        }
      });
  }

  check(
    "no hardcoded user-facing strings in components",
    hits.length === 0,
    hits.length
      ? `${hits.length} found\n        ${hits.slice(0, 12).join("\n        ")}`
      : `${files.length} files scanned`
  );
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
// ⚠ process.exitCode, NOT process.exit(). process.exit() tears the event loop down
// while the console.log lines above may still be flushing, and on Windows that races
// libuv into "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and an exit code
// of 127 -- a GREEN suite reported as a failed build, intermittently. Measured before
// the fix: verify:slippage 0/127/127/127/127/0, verify:upload 0/127/0/0/0/127.
// A gate that fails randomly trains a human to re-run until green, which is how a real
// failure gets dismissed under pressure. Setting exitCode lets node exit naturally once
// stdout has drained.
if (failures) process.exitCode = 1;
