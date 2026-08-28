// Generates CONTRACT_INVENTORY.md from the compiled artifacts and the source.
//
// WHY THIS EXISTS. A five-minute symbol lock lived in LFX1.sol and appeared nowhere in
// CLAUDE.md: a 437-line rewrite of a hand-maintained document dropped a real contract
// feature, silently, and nothing could have caught it. A hand-maintained inventory rots
// the moment someone edits the contract. A generated one cannot: it is rebuilt from the
// ABI and the source every time, and `npm run inventory` is wired into `npm run build`.
//
// It also reports COVERAGE: every identifier the contract exposes that CLAUDE.md never
// mentions. That list is the thing to look at after any contract change.
//
//   node scripts/gen-inventory.js          # write CONTRACT_INVENTORY.md
//   node scripts/gen-inventory.js --check  # exit 1 if the file is out of date
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "CONTRACT_INVENTORY.md");
const TARGETS = [
  ["LFX1", "contracts/LFX1.sol", "artifacts/contracts/LFX1.sol/LFX1.json"],
  ["LFX1Token", "contracts/LFX1Token.sol", "artifacts/contracts/LFX1Token.sol/LFX1Token.json"],
];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function sigOf(item) {
  const args = (item.inputs || []).map((i) => `${i.type} ${i.name}`.trim()).join(", ");
  const rets = (item.outputs || []).map((o) => o.type).join(", ");
  return `${item.name}(${args})${rets ? ` -> (${rets})` : ""}`;
}

// Source-derived facts the ABI cannot give: owner gating, declared defaults, constants.
function sourceFacts(src) {
  const ownerOnly = new Set();
  const fnRe = /function\s+(\w+)\s*\(([^)]*)\)([^{;]*)/g;
  let m;
  while ((m = fnRe.exec(src))) {
    if (/onlyOwner/.test(m[3])) ownerOnly.add(m[1]);
  }

  const consts = new Map();
  const constRe = /^\s*(?:uint\d*|int\d*|address|bool|bytes\d*|string)\s+(?:public\s+)?constant\s+(\w+)\s*=\s*([^;]+);/gm;
  while ((m = constRe.exec(src))) consts.set(m[1], m[2].trim());

  const defaults = new Map();
  const varRe = /^\s*(uint\d*|int\d*|address|bool|bytes\d*|string)\s+public\s+(?!constant|immutable)(\w+)\s*=\s*([^;]+);/gm;
  while ((m = varRe.exec(src))) defaults.set(m[2], { type: m[1], value: m[3].trim() });

  const noDefault = new Map();
  const bareRe = /^\s*(uint\d*|int\d*|address|bool|bytes\d*|string|mapping\([^)]*\)[^ ]*)\s+public\s+(?:immutable\s+)?(\w+)\s*;/gm;
  while ((m = bareRe.exec(src))) noDefault.set(m[2], m[1]);

  // Which state vars feed currentEconomicsHash()?
  const hashBody = (src.match(/function currentEconomicsHash\(\)[\s\S]*?\n    \}/) || [""])[0];
  const hashed = new Set(
    [...hashBody.matchAll(/^\s{12}(\w+),?$/gm)].map((x) => x[1])
  );

  return { ownerOnly, consts, defaults, noDefault, hashed };
}

function build() {
  const claude = read("CLAUDE.md");
  const missing = [];
  let md = `# Contract inventory — GENERATED, DO NOT HAND-EDIT

Regenerate with \`npm run inventory\`. It runs as part of \`npm run build\`.

This file exists because a five-minute symbol lock lived in \`LFX1.sol\` and appeared
nowhere in \`CLAUDE.md\` — a rewrite of a hand-maintained document dropped a real feature
and nothing caught it. Everything below is read from the compiled ABI and the source at
generation time, so it cannot drift from the contract. **\`CLAUDE.md\` explains WHY things
are the way they are; this file is the exhaustive WHAT.**

The coverage section at the end lists every exposed identifier that \`CLAUDE.md\` does not
mention. That list is what to read after any contract change.

`;

  for (const [name, srcPath, artPath] of TARGETS) {
    const src = read(srcPath);
    const abi = JSON.parse(read(artPath)).abi;
    const f = sourceFacts(src);

    const fns = abi.filter((x) => x.type === "function");
    const getters = fns.filter(
      (x) => x.stateMutability === "view" && (x.inputs || []).length <= 1 &&
        (f.consts.has(x.name) || f.defaults.has(x.name) || f.noDefault.has(x.name))
    );
    const getterNames = new Set(getters.map((g) => g.name));
    const writes = fns.filter((x) => !getterNames.has(x.name) &&
      x.stateMutability !== "view" && x.stateMutability !== "pure");
    const views = fns.filter((x) => !getterNames.has(x.name) &&
      (x.stateMutability === "view" || x.stateMutability === "pure"));

    md += `\n---\n\n## ${name}\n\n`;

    md += `### Constants (immutable by construction — changing one is a redeploy)\n\n`;
    md += `| name | value |\n|---|---|\n`;
    for (const [k, v] of f.consts) md += `| \`${k}\` | \`${v}\` |\n`;

    md += `\n### State variables that govern behaviour\n\n`;
    md += `| name | type | declared default | owner-settable via | in economics hash |\n|---|---|---|---|---|\n`;
    const setters = new Map();
    for (const w of writes) {
      if (!f.ownerOnly.has(w.name)) continue;
      const m = w.name.match(/^set(?:Default)?(.+)$/);
      if (m) setters.set(m[1].toLowerCase().replace(/bps$/, ""), w.name);
    }
    const allVars = new Map([...f.defaults].map(([k, v]) => [k, v]));
    for (const [k, t] of f.noDefault) if (!allVars.has(k)) allVars.set(k, { type: t, value: "—" });
    for (const [k, v] of allVars) {
      const key = k.toLowerCase().replace(/bps$/, "").replace(/^default/, "");
      const setter = setters.get(key) || [...setters.values()].find(
        (s) => s.toLowerCase().includes(k.toLowerCase().replace(/^default/, "").slice(0, 10))
      ) || "—";
      md += `| \`${k}\` | \`${v.type}\` | \`${v.value}\` | ${setter === "—" ? "**no setter — redeploy**" : `\`${setter}\``} | ${f.hashed.has(k) ? "yes" : "no"} |\n`;
    }

    md += `\n### Owner-gated functions\n\n`;
    md += `| function | what it changes |\n|---|---|\n`;
    for (const w of writes.filter((x) => f.ownerOnly.has(x.name))) {
      md += `| \`${sigOf(w)}\` | owner only |\n`;
    }

    md += `\n### Permissionless state-changing functions\n\n`;
    md += `| function | mutability |\n|---|---|\n`;
    for (const w of writes.filter((x) => !f.ownerOnly.has(x.name))) {
      md += `| \`${sigOf(w)}\` | ${w.stateMutability} |\n`;
    }

    md += `\n### Views\n\n`;
    md += `| function |\n|---|\n`;
    for (const v of views) md += `| \`${sigOf(v)}\` |\n`;

    md += `\n### Public getters (state and constants)\n\n`;
    md += getters.map((g) => `\`${g.name}\``).join(", ") + "\n";

    const errors = abi.filter((x) => x.type === "error");
    md += `\n### Custom errors (${errors.length})\n\n`;
    md += `| error | thrown where |\n|---|---|\n`;
    for (const e of errors) {
      const lines = src.split("\n")
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => l.includes(`revert ${e.name}(`))
        .map(([i]) => i);
      md += `| \`${sigOf(e)}\` | ${lines.length ? lines.map((l) => `L${l}`).join(", ") : "declared, never thrown"} |\n`;
    }

    const events = abi.filter((x) => x.type === "event");
    md += `\n### Events (${events.length})\n\n`;
    md += `| event | emitted at |\n|---|---|\n`;
    for (const e of events) {
      const lines = src.split("\n")
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => l.includes(`emit ${e.name}(`))
        .map(([i]) => i);
      md += `| \`${sigOf(e)}\` | ${lines.length ? lines.map((l) => `L${l}`).join(", ") : "**declared, never emitted**"} |\n`;
    }

    // Coverage: what CLAUDE.md never mentions.
    const ids = [
      ...fns.map((x) => x.name),
      ...errors.map((x) => x.name),
      ...events.map((x) => x.name),
      ...f.consts.keys(),
      ...allVars.keys(),
    ];
    for (const id of new Set(ids)) {
      if (!claude.includes(id)) missing.push(`${name}.${id}`);
    }
  }

  md += `\n---\n\n## CLAUDE.md coverage\n\n`;
  md += `Identifiers exposed by the contracts that \`CLAUDE.md\` never mentions: **${missing.length}**.\n\n`;
  md += `Not every one needs prose — a getter for a constant that is already described by\n`;
  md += `its constant does not. But anything here that changes BEHAVIOUR and is unexplained\n`;
  md += `is the shape of the symbol-lock gap, and should be read as a candidate.\n\n`;
  md += missing.map((m) => `- \`${m}\``).join("\n") + "\n";

  return { md, missing };
}

const { md, missing } = build();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== md) {
    console.error("CONTRACT_INVENTORY.md is out of date. Run: npm run inventory");
    process.exit(1);
  }
  console.log("CONTRACT_INVENTORY.md is up to date");
} else {
  fs.writeFileSync(OUT, md);
  console.log(`wrote CONTRACT_INVENTORY.md — ${missing.length} identifiers unmentioned in CLAUDE.md`);
}
