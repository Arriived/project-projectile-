// The palette, the two themes, and the buy/sell colouring.
//
// Three properties that are easy to break silently and impossible to notice in review:
//
//   1. THE DARK GROUND MUST BE NEUTRAL. It was #14140f — R20 G20 B15, a 5-point
//      red-over-blue bias derived by inverting the warm off-white. Principled derivation,
//      bad result: it read brown-black. Warmth that flatters a near-white page does not
//      survive inversion.
//
//   2. THE CHART'S PALETTE IS A COPY. lightweight-charts takes concrete colour strings at
//      construction and cannot read CSS custom properties, so PriceChart duplicates
//      --line/--muted/--pos/--neg. Change the tokens alone and the chart keeps drawing the
//      old theme against the new page — which looks like a rendering bug, not a stale
//      constant. This asserts the two agree.
//
//   3. COLOUR MUST NEVER BE THE ONLY SIGNAL, and the buy/sell text colour must be
//      readable in BOTH themes. A single choice fails half the cases: white on the dark
//      theme's --pos is 2.67:1, near-black on the light theme's --neg is 2.64:1. The
//      `color: var(--bg)` idiom works because the tokens already encode the inversion.
//
// Everything is read from the REAL styles.css and the REAL PriceChart.tsx. Nothing is
// retyped, so the check cannot pass against a copy that has drifted.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mts";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

// ⚠ Comments stripped first. This file's own CSS prose quotes every OLD value
// (#14140f, #2f2f29 …) while explaining why they were replaced; a checker that reads its
// own documentation is the defect CLAUDE.md §11.7 records and §12.6 makes a rule.
const cssRaw = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const css = stripComments(cssRaw);
const chart = stripComments(readFileSync(new URL("../src/components/token/PriceChart.tsx", import.meta.url), "utf8"));

/**
 * Read a token, merging EVERY block with that selector.
 *
 * ⚠ There is more than one `:root { }` in this file — `--card: #ffffff` is declared in its
 * own block far below the main palette. A version of this that read only the FIRST block
 * returned null for it and then threw inside the contrast maths, which is how the flaw was
 * found. Later declarations win, exactly as the cascade does.
 */
function token(selector: RegExp, name: string): string | null {
  let value: string | null = null;
  for (const block of css.matchAll(new RegExp(selector.source + "\\s*\\{([^}]*)\\}", "g"))) {
    const m = block[1].match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
    if (m) value = m[1].toLowerCase();
  }
  return value;
}
const light = (n: string) => token(/:root(?!\[)/, n);
const dark = (n: string) => token(/:root\[data-theme="dark"\]/, n);

/** Every token of one theme, for the "is this colour one of ours at all" check. */
function allTokens(which: (n: string) => string | null): Record<string, string> {
  const names = ["bg", "card", "soft", "line", "muted", "text", "accent", "pos", "neg", "warn"];
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = which(n);
    if (v) out[n] = v;
  }
  return out;
}

const rgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (h: string) =>
  rgb(h)
    .map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// ══ 1. THE DARK GROUND IS NEUTRAL ════════════════════════════════════════════════════
console.log("\ndark theme — neutral, not warm");

const NEUTRAL = ["bg", "card", "soft", "line", "muted", "text", "accent"] as const;
for (const name of NEUTRAL) {
  const v = dark(name);
  if (!v) {
    check(`T  --${name} is defined in the dark theme`, false, "MISSING");
    continue;
  }
  const [r, g, b] = rgb(v);
  check(
    `T  --${name} is exactly neutral (R = G = B)`,
    r === g && g === b,
    `${v} -> R${r} G${g} B${b}${r !== b ? `  R-B = ${r - b}  <- TINTED` : ""}`
  );
}
check(
  "T8 ⚠ the dark ground is NOT the old warm #14140f",
  dark("bg") !== "#14140f",
  dark("bg") ?? "?"
);
check(
  "T9 --bg (dark) is the light theme's --text exactly — neutral by construction",
  dark("bg") === light("text"),
  `${dark("bg")} vs ${light("text")}`
);

// ══ 2. THE CHART MIRRORS THE TOKENS ══════════════════════════════════════════════════
console.log("\nchart palette — a copy, so it must be checked against the source");

function palette(theme: "light" | "dark") {
  const block = chart.match(new RegExp(`${theme}:\\s*\\{([\\s\\S]*?)\\}`));
  if (!block) return null;
  const grab = (k: string) => block[1].match(new RegExp(`${k}:\\s*"(#[0-9a-fA-F]{3,8})"`))?.[1]?.toLowerCase() ?? null;
  return { text: grab("text"), grid: grab("grid"), border: grab("border"), up: grab("up"), down: grab("down"), flat: grab("flat") };
}
for (const theme of ["light", "dark"] as const) {
  const p = palette(theme);
  const tok = theme === "light" ? light : dark;
  if (!p) {
    check(`C  PALETTE.${theme} is readable`, false, "not found");
    continue;
  }
  check(`C  PALETTE.${theme}.text   === --muted`, p.text === tok("muted"), `${p.text} vs ${tok("muted")}`);
  check(`C  PALETTE.${theme}.border === --line`, p.border === tok("line"), `${p.border} vs ${tok("line")}`);
  check(`C  PALETTE.${theme}.up     === --pos`, p.up === tok("pos"), `${p.up} vs ${tok("pos")}`);
  check(`C  PALETTE.${theme}.down   === --neg`, p.down === tok("neg"), `${p.down} vs ${tok("neg")}`);
  check(`C  PALETTE.${theme}.flat   === --muted`, p.flat === tok("muted"), `${p.flat} vs ${tok("muted")}`);

  // ⚠ `grid` IS NOT THE SAME TOKEN IN BOTH THEMES, and that is pre-existing rather than
  // something this change introduced: light draws grid lines in --soft (#e9e9e5, one step
  // DARKER than its ground) while dark draws them in --line (#2e2e2e, two steps LIGHTER
  // than its ground). So the dark chart's gridlines are relatively more prominent than the
  // light chart's. Asserting "grid === --line" for both would have been asserting the bug
  // -- a check must pin what IS true, and the inconsistency is reported rather than
  // silently normalised, because changing the light chart is a visual decision.
  const gridToken = theme === "light" ? "soft" : "line";
  check(
    `C  PALETTE.${theme}.grid   === --${gridToken}  (⚠ differs by theme, see note)`,
    p.grid === tok(gridToken),
    `${p.grid} vs ${tok(gridToken)}`
  );

  // The property that actually matters: nothing in the chart may be a colour that is not
  // one of that theme's tokens. This is what catches a palette left behind by a token edit.
  const tokens = Object.values(allTokens(tok));
  const orphans = Object.entries(p).filter(([, v]) => v && !tokens.includes(v));
  check(
    `C  ⚠ every PALETTE.${theme} colour is one of that theme's tokens (no orphans)`,
    orphans.length === 0,
    orphans.length ? orphans.map(([k, v]) => `${k}=${v}`).join(", ") : `${Object.keys(p).length} checked`
  );
}

// ══ 3. EVERY SURFACE FOLLOWS THE THEME ═══════════════════════════════════════════════
console.log("\nsurfaces — no hardcoded white can outlive a theme switch");

// The only legitimate #ffffff is the light theme's own --card token. Any other is a
// surface that will stay white when the page goes dark. 13 of these were removed once.
const whiteHits = css
  .split("\n")
  .map((l, i) => [i + 1, l] as const)
  .filter(([, l]) => /#fff\b|#ffffff|background:\s*white/i.test(l))
  .filter(([, l]) => !/--card\s*:\s*#ffffff/.test(l));
check(
  "S1 ⚠ no hardcoded white surface in styles.css (the 13 stayed removed)",
  whiteHits.length === 0,
  whiteHits.length ? whiteHits.map(([n, l]) => `${n}: ${l.trim().slice(0, 48)}`).join(" | ") : "only --card: #ffffff, which is the token"
);
for (const rel of ["src/routes/TokenList.tsx", "src/routes/Create.tsx", "src/providers/ToastProvider.tsx", "src/components/token/TradePanel.tsx"]) {
  const src = stripComments(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));
  check(`S2 ${rel.split("/").pop()} hardcodes no white`, !/#fff\b|#ffffff|backgroundColor:\s*"white"/i.test(src));
}

// ══ 3b. NO SUPERSEDED TOKEN VALUE MAY SURVIVE IN CODE ════════════════════════════════
//
// ⚠ THE GENERAL FORM OF A CHECK THAT WAS TOO SPECIFIC, AND MISSED A LIVE BUG.
//
// The palette lives in styles.css but is COPIED wherever a consumer cannot read a CSS
// custom property. This suite already checked one copy -- PriceChart's PALETTE -- and
// asserted it matched. It never asked whether there were OTHER copies. There was one:
//
//   ThemeProvider.tsx set <meta name="theme-color"> to #14140f, the superseded dark
//   ground, so the iOS status bar and the Android task switcher painted the old
//   brown-black against a neutral #111111 page. Shipped, and confirmed on a real phone.
//
// So this does not enumerate the copies -- enumerating them is what failed. It asserts
// the property: a retired colour must not appear anywhere in TypeScript, whatever the
// reason. A new copy added tomorrow is covered without anyone remembering to add it here.
console.log("\nretired token values — none may survive in .ts/.tsx");

/**
 * Values that WERE tokens and are not any more.
 *
 * ⚠ THIS LIST GROWS EVERY TIME A TOKEN VALUE IS RETIRED. When you change a value in
 * styles.css, add the OLD one here. That is the whole maintenance contract, and it is the
 * step that turns "we changed the palette" into "the palette cannot half-change".
 *
 * The current entries are the warm dark ramp replaced on 5 September 2026 (see the
 * comment block above :root[data-theme="dark"] in styles.css).
 */
const RETIRED_TOKEN_VALUES = [
  "#14140f", // was --bg    (dark)  -> #111111
  "#ecece6", // was --text  (dark)  -> #ededed
  "#8f8f86", // was --muted (dark)  -> #8f8f8f
  "#2f2f29", // was --line  (dark)  -> #2e2e2e
  "#1f1f1a", // was --soft  (dark)  -> #1e1e1e
  "#1a1a15", // was --card  (dark)  -> #191919
] as const;

// ⚠ Comments are stripped first, and that is load-bearing rather than tidy. A file
// explaining "this was #14140f before" is documenting the change, not shipping the value
// — and a checker that cannot tell those apart is one people switch off. It is also the
// self-matching trap CLAUDE.md §11.7 records and §12.6 makes a rule.
const tsFiles: string[] = [];
const walkTs = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full);
    else if (/\.tsx?$/.test(full)) tsFiles.push(full);
  }
};
walkTs(fileURLToPath(new URL("../src", import.meta.url)));

const retiredHits: string[] = [];
for (const file of tsFiles) {
  const code = stripComments(readFileSync(file, "utf8"));
  code.split("\n").forEach((line, i) => {
    for (const dead of RETIRED_TOKEN_VALUES) {
      if (line.toLowerCase().includes(dead)) {
        retiredHits.push(`${file.split(/[\/]/).slice(-2).join("/")}:${i + 1} ${dead} -> ${line.trim().slice(0, 56)}`);
      }
    }
  });
}
check(
  `R1 ⚠ no retired token value appears in any of the ${tsFiles.length} .ts/.tsx files under src/`,
  retiredHits.length === 0,
  retiredHits.length ? retiredHits.join(" | ") : `${RETIRED_TOKEN_VALUES.length} retired values checked`
);

// ⚠ THE CONTROL. Without it R1 also passes if RETIRED_TOKEN_VALUES is emptied, or if the
// walker finds no files — both of which are "check does nothing" rather than "code clean".
check("R2 the walker actually found files to scan", tsFiles.length > 20, `${tsFiles.length} files`);
check("R3 the retired list is not empty", RETIRED_TOKEN_VALUES.length > 0);
// And the light tokens are UNCHANGED and legitimate: they must never be flagged.
const LIGHT_STILL_LIVE = ["#f3f3f0", "#111111", "#777777", "#d6d6d1", "#e9e9e5", "#ffffff"];
check(
  "R4 ⚠ live LIGHT token values are not in the retired list (they are unchanged and legal)",
  LIGHT_STILL_LIVE.every((v) => !(RETIRED_TOKEN_VALUES as readonly string[]).includes(v)),
  LIGHT_STILL_LIVE.join(" ")
);

// ══ 4. BUY IS GREEN, SELL IS RED ═════════════════════════════════════════════════════
console.log("\nbuy/sell — the tokens, both themes, and a signal that is not colour");

// ⚠ WHITESPACE-TOLERANT. The stylesheet aligns some descendant selectors with two spaces
// (`.presets-buy  .btn-tiny`), and a single-space pattern silently returns "" for those —
// which then reads as "this rule does not use --pos" rather than "the checker could not
// see the rule". A checker that fails to FIND a rule must never report that as the rule
// being wrong; B0 below makes the distinction explicit.
const rule = (sel: string) => {
  const pat = sel
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return css.match(new RegExp("(?:^|[},])\\s*" + pat + "\\s*\\{([^}]*)\\}", "m"))?.[1] ?? "";
};
for (const sel of [".tab-buy.on", ".tab-sell.on", ".btn-buy", ".btn-sell", ".presets-buy .btn-tiny", ".presets-sell .btn-tiny"]) {
  check(`B0 the rule for \`${sel}\` is found at all in styles.css`, rule(sel).length > 0);
}
check("B1 the active BUY tab uses --pos", /--pos/.test(rule(".tab-buy.on")));
check("B2 the active SELL tab uses --neg", /--neg/.test(rule(".tab-sell.on")));
check("B3 buy presets use --pos", /--pos/.test(rule(".presets-buy .btn-tiny")));
check("B4 sell presets use --neg", /--neg/.test(rule(".presets-sell .btn-tiny")));
check("B5 the primary buy button fills with --pos", /background:\s*var\(--pos\)/.test(rule(".btn-buy")));
check("B6 the primary sell button fills with --neg", /background:\s*var\(--neg\)/.test(rule(".btn-sell")));

// ⚠ THE ONE THAT PROTECTS READABILITY. `color: var(--bg)` is what makes a single
// declaration land the right way up in both themes.
check("B7 ⚠ the buy button takes its text colour from --bg", /color:\s*var\(--bg\)/.test(rule(".btn-buy")));
check("B8 ⚠ the sell button takes its text colour from --bg", /color:\s*var\(--bg\)/.test(rule(".btn-sell")));

// No new hues. Only --pos/--neg may appear on these controls.
const sideRules = [".tab-buy.on", ".tab-sell.on", ".btn-buy", ".btn-sell", ".presets-buy .btn-tiny", ".presets-sell .btn-tiny"]
  .map(rule)
  .join(" ");
const literalHues = sideRules.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
check(
  "B9 ⚠ no literal colour on any buy/sell control — tokens only, so no lime can creep in",
  literalHues.length === 0,
  literalHues.length ? literalHues.join(", ") : "all var(--pos)/var(--neg)/var(--bg)"
);

// ── contrast, measured from the real tokens ──
console.log("\ncontrast — computed from the tokens actually in the file");
const pairs: [string, string, string][] = [
  ["light buy  button text on fill", light("bg")!, light("pos")!],
  ["light sell button text on fill", light("bg")!, light("neg")!],
  ["dark  buy  button text on fill", dark("bg")!, dark("pos")!],
  ["dark  sell button text on fill", dark("bg")!, dark("neg")!],
  ["light active buy tab text on card", light("pos")!, light("card")!],
  ["light active sell tab text on card", light("neg")!, light("card")!],
  ["dark  active buy tab text on soft", dark("pos")!, dark("soft")!],
  ["dark  active sell tab text on soft", dark("neg")!, dark("soft")!],
  ["dark  body text on bg", dark("text")!, dark("bg")!],
  ["dark  muted on bg", dark("muted")!, dark("bg")!],
];
for (const [label, fg, bg] of pairs) {
  const r = ratio(fg, bg);
  check(`X  ${label} >= 4.5:1 (AA)`, r >= 4.5, `${fg} on ${bg} = ${r.toFixed(2)}:1`);
}

// ── the non-colour signal ──
// ⚠ Colour-blind and greyscale readers must still be able to tell which side is active.
// Three cues survive desaturation, and this asserts all three exist rather than trusting
// that one of them does.
const tabOn = rule(".tab.on");
check("N1 the active tab is BOLD (survives greyscale)", /font-weight:\s*600/.test(tabOn), tabOn.trim().slice(0, 60));
check("N2 the active tab has its own BACKGROUND (survives greyscale)", /background:\s*var\(--soft\)/.test(tabOn));
check(
  "N3 the active tab has an UNDERLINE BAR (survives greyscale)",
  /\.tab-buy\.on::after[\s\S]{0,40}\.tab-sell\.on::after\s*\{[^}]*height:\s*2px/.test(css)
);
const panel = stripComments(readFileSync(new URL("../src/components/token/TradePanel.tsx", import.meta.url), "utf8"));
check("N4 aria-selected carries the active side to assistive tech", /aria-selected=\{side === "buy"\}/.test(panel));
check("N5 the tabs are a real tablist", /role="tablist"/.test(panel) && /role="tab"/.test(panel));

console.log(failures === 0 ? `\n  all theme checks passed\n` : `\n  ${failures} FAILED\n`);
// process.exitCode, not process.exit() — see the note in the other verify scripts.
process.exitCode = failures === 0 ? 0 : 1;
